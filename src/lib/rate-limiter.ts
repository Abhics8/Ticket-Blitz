import { redis } from './redis';
import { config } from '../config';

/**
 * Distributed token-bucket rate limiter. The whole check-and-decrement runs as
 * a single atomic Lua script inside Redis, so it's correct across many API
 * instances. Protects against scalper bots hammering the booking endpoints.
 */
const SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])
if tokens == nil then tokens = capacity; ts = now end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
if tokens >= requested then
  allowed = 1
  tokens = tokens - requested
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, math.ceil(capacity / refill) + 1)
return allowed
`;

export async function allow(clientKey: string): Promise<boolean> {
  const now = Date.now() / 1000;
  const res = await redis.eval(
    SCRIPT,
    1,
    `rl:${clientKey}`,
    config.rateLimit.capacity,
    config.rateLimit.refillPerSec,
    now,
    1
  );
  return Number(res) === 1;
}
