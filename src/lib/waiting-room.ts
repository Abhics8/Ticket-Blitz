import { redis } from './redis';
import { config } from '../config';
import { waitingRoomDepth } from '../metrics';

/**
 * Virtual waiting room (surge control), à la Ticketmaster. Users join a
 * Redis-backed FIFO queue and receive a position. An admission ticker promotes
 * the front N users per second into an "admitted" set; only admitted users may
 * book. Keeps the booking tier at a controlled throughput during onsales.
 */
const QUEUE = (event: string) => `waitroom:${event}`;
const ADMITTED = (event: string) => `admitted:${event}`;

export async function join(event: string, userId: string): Promise<number> {
  await redis.zadd(QUEUE(event), 'NX', Date.now(), userId);
  return position(event, userId);
}

export async function position(event: string, userId: string): Promise<number> {
  const rank = await redis.zrank(QUEUE(event), userId);
  return rank === null ? -1 : rank + 1;
}

export async function isAdmitted(event: string, userId: string): Promise<boolean> {
  if (!config.waitingRoom.enabled) return true;
  return (await redis.sismember(ADMITTED(event), userId)) === 1;
}

/** Promote the front of the queue. Called on an interval by the worker. */
export async function admitBatch(event: string): Promise<number> {
  const users = await redis.zrange(QUEUE(event), 0, config.waitingRoom.admitPerTick - 1);
  if (users.length === 0) {
    waitingRoomDepth.set(0);
    return 0;
  }
  const pipe = redis.pipeline();
  for (const u of users) {
    pipe.sadd(ADMITTED(event), u);
    pipe.zrem(QUEUE(event), u);
  }
  pipe.expire(ADMITTED(event), config.waitingRoom.admitTtlSeconds);
  await pipe.exec();
  waitingRoomDepth.set(await redis.zcard(QUEUE(event)));
  return users.length;
}
