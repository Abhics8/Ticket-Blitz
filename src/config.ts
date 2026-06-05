import 'dotenv/config';

/**
 * Central, typed configuration. Everything is environment-overridable so the
 * same image runs locally, in docker-compose, and on Kubernetes.
 */
export const config = {
  port: Number(process.env.PORT) || 3000,
  instanceId: process.env.INSTANCE_ID || `api-${process.pid}`,

  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),

  topics: {
    bookingEvents: 'booking-events',
    dlq: 'booking-events.dlq',
  },

  // Pessimistic lock: held only for the brief critical section.
  lockTtlSeconds: Number(process.env.LOCK_TTL_SECONDS) || 10,
  // How long a seat stays HELD before auto-expiring back to AVAILABLE.
  holdTtlSeconds: Number(process.env.HOLD_TTL_SECONDS) || 120,

  // Token-bucket rate limit, per client key.
  rateLimit: {
    capacity: Number(process.env.RL_CAPACITY) || 20,
    refillPerSec: Number(process.env.RL_REFILL) || 10,
  },

  // Virtual waiting room (surge control). Disabled by default.
  waitingRoom: {
    enabled: process.env.WAITING_ROOM === 'true',
    admitPerTick: Number(process.env.WR_ADMIT) || 50,
    tickMs: Number(process.env.WR_TICK_MS) || 1000,
    admitTtlSeconds: Number(process.env.WR_ADMIT_TTL) || 300,
  },

  // Outbox relay poll interval.
  outboxPollMs: Number(process.env.OUTBOX_POLL_MS) || 500,
  // Reservation expiry sweep interval.
  sweepMs: Number(process.env.SWEEP_MS) || 2000,
} as const;

export type AppConfig = typeof config;
