import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export class DistributedLock {
  constructor(private readonly lockKey: string, private readonly ttlSeconds: number = 30) {}

  async acquire(userId: string): Promise<boolean> {
    const result = await redis.set(this.lockKey, userId, 'EX', this.ttlSeconds, 'NX');
    return result === 'OK';
  }

  async release(userId: string): Promise<boolean> {
    // Lua script to ensure atomic release only if the current user owns it
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await redis.eval(script, 1, this.lockKey, userId);
    return result === 1;
  }
}
