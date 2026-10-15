import { Redis, RedisOptions } from "ioredis";
import { env } from "../../config/env.js";
import { logger } from "../logging/logger.js";

export function buildRedisOptions(maxRetriesPerRequest: number | null = 3): RedisOptions {
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    db: env.REDIS_DB,
    maxRetriesPerRequest,
    enableReadyCheck: true,
    tls: env.REDIS_TLS_ENABLED ? {} : undefined,
    retryStrategy(times: number) {
      return Math.min(times * 100, 3000);
    },
  };
}

export const redis = new Redis(buildRedisOptions(3));

redis.on("connect", () => logger.info("Redis client connected"));
redis.on("error", (err) => logger.error({ err }, "Redis client error"));
