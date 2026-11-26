import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";
import { _ } from "meteor/underscore";
import debug from "../debug";
import { RedisPipe, Events } from "../constants";
import getFieldsOfInterestFromAll from "./lib/getFieldsOfInterestFromAll";
import Config from "../config";

class RedisSubscriptionManager {
  init() {
    if (this.isInitialized) {
      return;
    }
    this.uid = Random.id();
    this.queue = new Meteor._AsynchronousQueue();
    this.store = {}; // {channel: [RedisSubscribers]}
    this.channelHandlers = {}; // {channel: handler}
    // Subscribers sharing a channel must wait for the same SUBSCRIBE acknowledgement
    this.channelReadiness = {};

    this.isInitialized = true;
  }

  /**
   * Returns all RedisSubscribers regardless of channel
   */
  getAllRedisSubscribers() {
    let redisSubscribers = [];
    for (let channel in this.store) {
      this.store[channel].forEach((_redisSubscriber) =>
        redisSubscribers.push(_redisSubscriber)
      );
    }

    return redisSubscribers;
  }

  /**
   * @param redisSubscriber
   */
  attach(redisSubscriber) {
    const attachedChannels = [];
    const subscriptions = [];

    // Register on the shared queue, but await SUBSCRIBE replies outside it so
    // attaching an observer does not hold up message delivery to existing ones
    const ready = this.queue.runTask(() => {
      for (const channel of new Set(redisSubscriber.channels)) {
        if (!this.store[channel]) {
          this.initializeChannel(channel);
        }

        if (!this.store[channel].includes(redisSubscriber)) {
          this.store[channel].push(redisSubscriber);
          attachedChannels.push(channel);
        }

        subscriptions.push(this.channelReadiness[channel]);
      }
    }).then(() => Promise.all(subscriptions)).catch(async (error) => {
      await this.queue.runTask(() => {
        for (const channel of attachedChannels) {
          if (!this.store[channel]) {
            continue;
          }

          this.store[channel] = _.without(
            this.store[channel],
            redisSubscriber
          );

          if (this.store[channel].length === 0) {
            this.destroyChannel(channel);
          }
        }
      });

      throw error;
    });

    ready.catch((error) => {
      debug("[RedisSubscriptionManager] Failed to attach subscriber:", error);
    });

    return ready;
  }

  /**
   * @param redisSubscriber
   */
  detach(redisSubscriber) {
    this.queue.queueTask(() => {
      _.each(redisSubscriber.channels, (channel) => {
        if (!this.store[channel]) {
          return debug(
            "[RedisSubscriptionManager] Trying to detach a subscriber on a non existent channels."
          );
        } else {
          this.store[channel] = _.without(this.store[channel], redisSubscriber);

          if (this.store[channel].length === 0) {
            this.destroyChannel(channel);
          }
        }
      });
    });
  }

  /**
   * @param channel
   */
  initializeChannel(channel) {
    debug(`[RedisSubscriptionManager] Subscribing to channel: ${channel}`);

    // create the handler for this channel
    const self = this;
    const handler = function (message) {
      self.queue.queueTask(async () => {
        await self.process(channel, message, true);
      });
    };

    this.channelHandlers[channel] = handler;
    this.store[channel] = [];

    const { pubSubManager } = Config;
    this.channelReadiness[channel] = pubSubManager.subscribe(channel, handler);

    return this.channelReadiness[channel];
  }

  /**
   * @param channel
   */
  destroyChannel(channel) {
    debug(`[RedisSubscriptionManager] Unsubscribing from channel: ${channel}`);

    const { pubSubManager } = Config;
    pubSubManager.unsubscribe(channel, this.channelHandlers[channel]);

    delete this.store[channel];
    delete this.channelHandlers[channel];
    delete this.channelReadiness[channel];
  }

  /**
   * @param channel
   * @param data
   * @param [fromRedis=false]
   */
  async process(channel, data, fromRedis) {
    // messages from redis that contain our uid were handled
    // optimistically, so we can drop them.
    if (fromRedis && data[RedisPipe.UID] === this.uid) {
      return;
    }

    let subscribers = this.store[channel];
    if (!subscribers) {
      return;
    }

    let isSynthetic = data[RedisPipe.SYNTHETIC];

    debug(
      `[RedisSubscriptionManager] Received ${
        isSynthetic ? "synthetic " : ""
      }event: "${data[RedisPipe.EVENT]}" to "${channel}"`
    );

    const eventType = isSynthetic ? "synthetic" : "normal";
    const eventArgs = isSynthetic
      ? [
        data[RedisPipe.EVENT],
        data[RedisPipe.DOC],
        data[RedisPipe.MODIFIER],
        data[RedisPipe.MODIFIED_TOP_LEVEL_FIELDS],
      ]
      : [
        data[RedisPipe.EVENT],
        data[RedisPipe.DOC],
        data[RedisPipe.FIELDS],
      ];

    // Buffer before fetching from Mongo; these observers will reconcile later
    // Other subscribers on the same channel continue through the normal path
    subscribers = subscribers.filter(
      (subscriber) => !subscriber.bufferEvent(eventType, eventArgs)
    );

    if (subscribers.length === 0) {
      return;
    }

    if (!isSynthetic) {
      const collection = subscribers[0].observableCollection.collection;

      let doc;
      if (data[RedisPipe.EVENT] === Events.REMOVE) {
        doc = data[RedisPipe.DOC];
      } else {
        doc = await this.getDoc(collection, subscribers, data);
      }

      // if by any chance it was deleted after it got dispatched
      // doc will be undefined
      if (!doc) {
        return;
      }

      for (const redisSubscriber of subscribers) {
        try {
          await redisSubscriber.process(
            data[RedisPipe.EVENT],
            doc,
            data[RedisPipe.FIELDS]
          );
        } catch (e) {
          debug(
            `[RedisSubscriptionManager] Exception while processing event: ${e.toString()}`
          );
        }
      }
    } else {
      for (const redisSubscriber of subscribers) {
        try {
          await redisSubscriber.processSynthetic(
            data[RedisPipe.EVENT],
            data[RedisPipe.DOC],
            data[RedisPipe.MODIFIER],
            data[RedisPipe.MODIFIED_TOP_LEVEL_FIELDS]
          );
        } catch (e) {
          debug(
            `[RedisSubscriptionManager] Exception while processing synthetic event: ${e.toString()}`
          );
        }
      }
    }
  }

  /**
   * @param collection
   * @param subscribers
   * @param data
   */
  async getDoc(collection, subscribers, data) {
    let doc = data[RedisPipe.DOC];

    if (
      collection._redisOplog &&
      !collection._redisOplog.protectAgainstRaceConditions
    ) {
      // If there's no protection against race conditions
      // It means we have received the full doc in doc

      return doc;
    }

    const fieldsOfInterest = getFieldsOfInterestFromAll(subscribers);

    if (fieldsOfInterest === true) {
      doc = await collection.findOneAsync(doc._id);
    } else {
      doc = await collection.findOneAsync(doc._id, {
        fields: fieldsOfInterest,
      });
    }

    return doc;
  }
}

export default new RedisSubscriptionManager();
