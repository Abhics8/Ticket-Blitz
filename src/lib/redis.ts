import Redis from 'ioredis';
import { config } from '../config';

/**
 * Shared ioredis connection factory. Pub/sub needs dedicated connections
 * (a connection in subscribe mode can't run normal commands), so the
 * Socket.IO adapter gets its own pub/sub pair.
 */
export const createRedis = (): Redis =>
  new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

// General-purpose client for locks, rate limiting, idempotency, queues.
export const redis = createRedis();

// Dedicated pair for the Socket.IO Redis adapter (cross-instance fan-out).
export const pubClient = createRedis();
export const subClient = pubClient.duplicate();

// A Redis blip must never crash the process — log and let ioredis reconnect.
redis.on('error', (e: Error) => console.error('[redis]', e.message));
pubClient.on('error', () => undefined);
subClient.on('error', () => undefined);
