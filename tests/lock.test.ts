import { DistributedLock } from '../src/lib/redis-lock';
import Redis from 'ioredis';

let mockStore: Record<string, string> = {};

// Mock the entire ioredis module
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => {
    return {
      set: jest.fn(async (key, value, mode1, ttl, mode2) => {
        if (mode2 === 'NX' && !mockStore[key]) {
          mockStore[key] = value;
          return 'OK';
        }
        return null;
      }),
      eval: jest.fn(async (script, numkeys, key, value) => {
        if (mockStore[key] === value) {
          delete mockStore[key];
          return 1;
        }
        return 0;
      })
    };
  });
});

describe('Distributed Redis Lock', () => {
  const lockKey = 'seat:123';
  let lock: DistributedLock;

  beforeEach(() => {
    mockStore = {};
    lock = new DistributedLock(lockKey);
  });

  test('should acquire lock successfully when available', async () => {
    const success = await lock.acquire('user:1');
    expect(success).toBe(true);
  });

  test('should fail to acquire lock when already held by another user', async () => {
    await lock.acquire('user:2');
    const success = await lock.acquire('user:3');
    expect(success).toBe(false); // Fails because of NX parameter
  });

  test('should release lock successfully if holding the lock', async () => {
    await lock.acquire('user:4');
    const released = await lock.release('user:4');
    expect(released).toBe(true);
  });

  test('should fail to release lock if held by someone else', async () => {
    await lock.acquire('user:5'); // User 5 takes it
    const released = await lock.release('user:6'); // User 6 tries to release it
    expect(released).toBe(false);
  });
});
