import { Meteor } from "meteor/meteor";
import { EJSON } from "meteor/ejson";

import { Events, Strategy } from "../constants";
import { getProcessor } from "../processors";
import extractIdsFromSelector from "../utils/extractIdsFromSelector";
import RedisSubscriptionManager from "./RedisSubscriptionManager";
import syntheticProcessor from "../processors/synthetic";
import getDedicatedChannel from "../utils/getDedicatedChannel";
import reload from "../processors/actions/reload";

export default class RedisSubscriber {
  /**
   * @param observableCollection
   * @param strategy
   */
  constructor(observableCollection, strategy, { buffering = false } = {}) {
    this.observableCollection = observableCollection;
    this.strategy = strategy;
    this.processor = getProcessor(strategy);
    this._buffering = buffering;
    this._bufferedEvents = [];
    this._stopped = false;

    // We do this because we override the behavior of dedicated "_id" channels
    this.channels = this.getChannels(this.observableCollection.channels);

    this.ready = RedisSubscriptionManager.attach(this);
  }

  /**
   * @param channels
   * @returns {*}
   */
  getChannels(channels) {
    const collectionName = this.observableCollection.collectionName;

    switch (this.strategy) {
      case Strategy.DEFAULT:
      case Strategy.LIMIT_SORT:
        return channels;
      case Strategy.DEDICATED_CHANNELS:
        const ids = extractIdsFromSelector(this.observableCollection.selector);

        return ids.map((id) => getDedicatedChannel(collectionName, id));
      default:
        throw new Meteor.Error(`Strategy could not be found: ${this.strategy}`);
    }
  }

  /**
   * @param args
   */
  async process(...args) {
    if (this.bufferEvent("normal", args)) {
      return;
    }

    if (this._stopped) {
      return;
    }

    await this.processor.call(null, this.observableCollection, ...args);
  }

  /**
   * @param event
   * @param doc
   * @param modifier
   * @param modifiedTopLevelFields
   */
  async processSynthetic(...args) {
    if (this.bufferEvent("synthetic", args)) {
      return;
    }

    if (this._stopped) {
      return;
    }

    await syntheticProcessor(this.observableCollection, ...args);
  }

  /**
   * Detaches from RedisSubscriptionManager
   */
  stop() {
    if (this._stopped) {
      return;
    }

    this._stopped = true;
    this._bufferedEvents = [];

    try {
      RedisSubscriptionManager.detach(this);
    } catch (e) {
      console.warn(
        `[RedisSubscriber] Weird! There was an error while stopping the publication: `,
        e
      );
    }
  }

  /**
   * Retrieves the fields that are used for matching the validity of the document
   *
   * @returns {array}
   */
  getFieldsOfInterest() {
    return this.observableCollection.fieldsOfInterest;
  }

  takeBufferedEvents() {
    const bufferedEvents = this._bufferedEvents;
    this._bufferedEvents = [];

    const events = [];
    // Normal events trigger a fresh Mongo read, so one per document is enough
    // Keep all reported fields for processors that depend on sort keys
    const normalEventsById = new Map();

    for (const event of bufferedEvents) {
      if (event.type !== "normal") {
        // Do not merge normal events across synthetic mutations or reloads
        normalEventsById.clear();
        events.push(event);
        continue;
      }

      const key = EJSON.stringify(event.args[1]._id);
      const previous = normalEventsById.get(key);

      if (previous) {
        previous.args[2] = Array.from(
          new Set([...(previous.args[2] || []), ...(event.args[2] || [])])
        );
      } else {
        normalEventsById.set(key, event);
        events.push(event);
      }
    }

    return events;
  }

  bufferEvent(type, args) {
    if (this._stopped) {
      return true;
    }

    if (!this._buffering) {
      return false;
    }

    this._bufferedEvents.push({
      type,
      args: EJSON.clone(args),
    });

    return true;
  }

  async reconcileAndActivate() {
    // Wait only for the batch captured after the snapshot. A continuously growing
    // buffer must not keep the observer from becoming ready
    const initialEvents = this.takeBufferedEvents();

    for (const event of initialEvents) {
      await this.reconcileEvent(event);
    }

    if (this._stopped) {
      throw new Meteor.Error("redis-oplog-observer-stopped");
    }

    // Keep buffering while later batches drain outside the shared delivery queue
    // Readiness does not wait for this work; tryActivate switches to live delivery
    this.drainBufferedEvents().catch((error) => {
      if (!this._stopped) {
        Meteor._debug(
          "[RedisSubscriber] Failed to drain buffered events:",
          error
        );
      }
    });
  }

  async drainBufferedEvents() {
    while (!this._stopped) {
      if (await this.tryActivate()) {
        return;
      }

      const events = this.takeBufferedEvents();

      for (const event of events) {
        try {
          await this.reconcileEvent(event);
        } catch (error) {
          if (this._stopped) {
            return;
          }

          Meteor._debug(
            "[RedisSubscriber] Failed to process buffered event:",
            error
          );
        }
      }
    }
  }

  async reconcileEvent({ type, args }) {
    if (this._stopped) {
      throw new Meteor.Error("redis-oplog-observer-stopped");
    }

    const oc = this.observableCollection;

    // Synthetic mutations are not stored in Mongo and must be applied as received
    if (type === "synthetic") {
      await syntheticProcessor(oc, ...args);
      return;
    }

    if (type === "reload") {
      await reload(oc);
      return;
    }

    // Buffered payloads may be older than the snapshot or subsequent writes
    // Read Mongo again and let the processor reconcile membership and fields
    const docId = args[1]._id;
    const doc = await oc.collection.findOneAsync(docId, {
      fields: oc._sharedProjection,
    });

    if (this._stopped) {
      throw new Meteor.Error("redis-oplog-observer-stopped");
    }

    if (doc) {
      const oldDoc = oc.store.get(docId);
      // Include old keys so removed fields, including sort keys, are considered
      const modifiedFields = Array.from(
        new Set([
          ...Object.keys(oldDoc || {}),
          ...Object.keys(doc),
          ...(args[2] || []),
        ])
      );

      await this.processor(oc, Events.UPDATE, doc, modifiedFields);
    } else {
      await this.processor(oc, Events.REMOVE, { _id: docId });
    }
  }

  tryActivate() {
    // Run after earlier queued deliveries and keep the check-and-switch synchronous
    // No event may slip between finding an empty buffer and enabling live delivery
    return RedisSubscriptionManager.queue.runTask(() => {
      if (this._stopped) {
        throw new Meteor.Error("redis-oplog-observer-stopped");
      }

      if (this._bufferedEvents.length > 0) {
        return false;
      }

      this._buffering = false;
      return true;
    });
  }

  async reload() {
    if (this.bufferEvent("reload", [])) {
      return;
    }

    if (this._stopped) {
      return;
    }

    await reload(this.observableCollection);
  }
}
