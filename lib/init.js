// https://github.com/luin/ioredis#connect-to-redis
import Config from "./config";
import extendMongoCollection from "./mongo/extendMongoCollection";
import RedisSubscriptionManager from "./redis/RedisSubscriptionManager";
import PubSubManager from "./redis/PubSubManager";
import { getRedisListener } from "./redis/getRedisClient";
import deepExtend from "deep-extend";

let isInitialized = false;

export default (config = {}) => {
  if (isInitialized) {
    throw "You cannot initialize RedisOplog twice.";
  }

  isInitialized = true;

  deepExtend(Config, config);

  Object.assign(Config, {
    isInitialized: true,
    oldPublish: Meteor.publish,
  });

  extendMongoCollection();

  // this initializes the listener singleton with the proper onConnect functionality
  getRedisListener({
    async onConnect() {
      // A subscriber can appear under several channels; reload it only once
      const subscribers = new Set(
        RedisSubscriptionManager.getAllRedisSubscribers()
      );

      for (const subscriber of subscribers) {
        // Respect buffering if Redis reconnects while the snapshot is loading
        await subscriber.reload();
      }
    },
  });

  RedisSubscriptionManager.init();
  Config.pubSubManager = new PubSubManager();
};
