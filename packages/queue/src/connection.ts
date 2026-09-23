import IORedis, { type Redis } from "ioredis";

// Singleton Redis connection, same globalThis-caching trick used for the
// Prisma client in packages/database — avoids opening a fresh connection
// per hot-reload in dev, and per BullMQ Queue/Worker instance.
const globalForRedis = globalThis as unknown as { __redisConnection?: Redis };

export function getRedisConnection(): Redis {
  if (!globalForRedis.__redisConnection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error(
        "REDIS_URL is not set. Copy .env.example to .env and point it at your " +
          "local Redis (see infrastructure/docker/docker-compose.yml for the dev one).",
      );
    }
    // BullMQ requires this exact setting — it manages retries/blocking
    // commands itself and does not tolerate ioredis retrying underneath it.
    globalForRedis.__redisConnection = new IORedis(url, {
      maxRetriesPerRequest: null,
    });
  }
  return globalForRedis.__redisConnection;
}
