import { redis } from './redis';

/**
 * Idempotency-Key support. A client retrying a request (network blip, double
 * tap) reuses its key; we replay the original response instead of booking
 * twice. Backed by Redis with a 24h TTL.
 */
const TTL_SECONDS = 86_400;

export async function getCached<T>(key: string): Promise<T | null> {
  const v = await redis.get(`idem:${key}`);
  return v ? (JSON.parse(v) as T) : null;
}

export async function store(key: string, value: unknown): Promise<void> {
  await redis.set(`idem:${key}`, JSON.stringify(value), 'EX', TTL_SECONDS);
}

/** Short lock so two concurrent requests with the same key don't both run. */
export async function acquireProcessing(key: string): Promise<boolean> {
  const r = await redis.set(`idem:lock:${key}`, '1', 'EX', 30, 'NX');
  return r === 'OK';
}

export async function releaseProcessing(key: string): Promise<void> {
  await redis.del(`idem:lock:${key}`);
}
