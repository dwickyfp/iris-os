import { MemoryCache } from "./memory-cache";

import { IS_DEV } from "lib/const";
import logger from "logger";
import { Cache } from "./cache.interface";
import { SafeRedisCache } from "./safe-redis-cache";

declare global {
  // eslint-disable-next-line no-var
  var __server__cache__: Cache | undefined;
}

const createCache = () => {
  // Set REDIS_URL to share cache entries across web and worker processes.
  // Without it every process falls back to its own in-memory cache.
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    logger.info("Using SafeRedisCache with automatic memory fallback");
    return new SafeRedisCache({
      redisUrl,
      fallbackToMemory: true,
      redisOptions: {
        retryStrategy: (times) => {
          if (times > 3) {
            logger.error("Redis connection failed after 3 retries");
            return null;
          }
          return Math.min(times * 1000, 3000);
        },
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        connectTimeout: 5000,
        commandTimeout: 5000,
      },
    });
  }

  if (!IS_DEV) {
    logger.warn("No REDIS_URL configured, using per-process MemoryCache");
  } else {
    logger.info("Using MemoryCache for development");
  }
  return new MemoryCache();
};

const serverCache = globalThis.__server__cache__ || createCache();

if (IS_DEV) {
  globalThis.__server__cache__ = serverCache;
}

export { serverCache };
