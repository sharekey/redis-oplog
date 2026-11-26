import { getRedisListener, getRedisPusher } from "./getRedisClient";

/**
 * Manages communication with Redis
 * Unifies all libraries that use this
 */
export default class PubSubManager {
  constructor() {
    this.channelHandlers = {};
    this.queue = new Meteor._AsynchronousQueue();

    this.listener = getRedisListener();
    this.pusher = getRedisPusher();

    this._initMessageListener();
  }

  /**
   * Pushes to Redis
   * @param {string} channel
   * @param {object} message
   */
  async publish(channel, message) {
    await this.pusher.publish(channel, EJSON.stringify(message));
  }

  /**
   * @param {string} channel
   * @param {function} handler
   * @returns {Promise<void>} Resolves once Redis is subscribed and the handler is registered
   */
  subscribe(channel, handler) {
    const ready = new Promise((resolve, reject) => {
      this.queue.queueTask(async () => {
        try {
          if (!this.channelHandlers[channel]) {
            await this._initChannel(channel, handler);
          } else {
            this.channelHandlers[channel].push(handler);
          }

          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    // Existing callers may ignore the returned Promise
    ready.catch((error) => {
      Meteor._debug("[PubSubManager] Failed to subscribe:", channel, error);
    });

    return ready;
  }

  /**
   * @param {string} channel
   * @param {function} handler
   */
  unsubscribe(channel, handler) {
    this.queue.queueTask(async () => {
      if (!this.channelHandlers[channel]) {
        return;
      }

      this.channelHandlers[channel] = this.channelHandlers[channel].filter(
        (_handler) => {
          return _handler !== handler;
        }
      );

      if (this.channelHandlers[channel].length === 0) {
        await this._destroyChannel(channel);
      }
    });
  }

  /**
   * Initializes listening for redis messages
   * @private
   */
  _initMessageListener() {
    const self = this;

    this.listener.on(
      "message",
      Meteor.bindEnvironment(async function (channel, _message) {
        if (self.channelHandlers[channel]) {
          const message = EJSON.parse(_message);
          for (const channelHandler of self.channelHandlers[channel]) {
            await channelHandler(message);
          }
        }
      })
    );
  }

  /**
   * @param channel
   * @private
   */
  async _initChannel(channel, handler) {
    // Install the handler before awaiting SUBSCRIBE: messages can arrive as soon
    // as Redis accepts it, before this continuation resumes
    this.channelHandlers[channel] = [handler];

    try {
      await this.listener.subscribe(channel);
    } catch (error) {
      delete this.channelHandlers[channel];
      throw error;
    }
  }

  /**
   * @param channel
   * @private
   */
  async _destroyChannel(channel) {
    await this.listener.unsubscribe(channel);

    delete this.channelHandlers[channel];
  }
}
