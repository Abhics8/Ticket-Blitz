import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db';
import { redis } from '../lib/redis';
import { DistributedLock } from '../lib/redis-lock';
import { config } from '../config';
import { lockContention, reservationsActive } from '../metrics';

/**
 * Core booking logic. Correctness rests on THREE independent layers, so the
 * system is safe even if any one of them fails:
 *
 *   1. Redis distributed lock (pessimistic) — serialises the critical section
 *      across all API instances; a crashed holder is freed by the lock TTL.
 *   2. Version-column compare-and-swap (optimistic) — the UPDATE only applies
 *      if the row hasn't changed since we read it, so a lost update is
 *      impossible even if the lock expired mid-flight.
 *   3. Booking.seatId UNIQUE constraint (database) — the final backstop;
 *      Postgres physically cannot persist two bookings for one seat.
 */

export type BookResult =
  | { status: 'BOOKED'; bookingId: string }
  | { status: 'HELD'; reservationId: string; expiresAt: string }
  | { status: 'CONFIRMED'; bookingId: string }
  | { status: 'TAKEN' }
  | { status: 'CONTENDED' }
  | { status: 'NOT_FOUND' }
  | { status: 'EXPIRED' }
  | { status: 'FORBIDDEN' };

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

async function withSeatLock<T>(
  seatId: string,
  critical: () => Promise<T>,
  onContended: () => T
): Promise<T> {
  const lock = new DistributedLock(`lock:seat:${seatId}`, config.lockTtlSeconds);
  const token = randomUUID();
  if (!(await lock.acquire(token))) {
    lockContention.inc();
    return onContended();
  }
  try {
    return await critical();
  } finally {
    await lock.release(token);
  }
}

async function findSeat(seatNumber: number, eventId?: string) {
  return prisma.seat.findFirst({
    where: { number: seatNumber, ...(eventId ? { eventId } : {}) },
  });
}

async function ensureUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.user.upsert({
    where: { email: userId },
    update: {},
    create: { id: userId, email: userId, name: 'Guest' },
  });
}

/** One-shot book (AVAILABLE -> BOOKED). Used by the load test / fast path. */
export async function bookSeat(params: {
  seatNumber: number;
  userId: string;
  eventId?: string;
}): Promise<BookResult> {
  const seat = await findSeat(params.seatNumber, params.eventId);
  if (!seat) return { status: 'NOT_FOUND' };

  return withSeatLock(
    seat.id,
    async () => {
      try {
        return await prisma.$transaction(async (tx) => {
          const upd = await tx.seat.updateMany({
            where: { id: seat.id, version: seat.version, status: 'AVAILABLE' },
            data: { status: 'BOOKED', version: { increment: 1 } },
          });
          if (upd.count === 0) return { status: 'TAKEN' } as BookResult;

          await ensureUser(tx, params.userId);
          const booking = await tx.booking.create({
            data: { userId: params.userId, seatId: seat.id },
          });
          await tx.outboxEvent.create({
            data: {
              aggregateId: seat.id,
              type: 'SEAT_BOOKED',
              payload: {
                seatId: seat.id,
                seatNumber: seat.number,
                userId: params.userId,
                bookingId: booking.id,
              },
            },
          });
          return { status: 'BOOKED', bookingId: booking.id } as BookResult;
        });
      } catch (e) {
        if (isUniqueViolation(e)) return { status: 'TAKEN' } as BookResult;
        throw e;
      }
    },
    (): BookResult => ({ status: 'CONTENDED' })
  );
}

/** Phase 1 of two-phase booking: AVAILABLE -> HELD with a TTL. */
export async function reserveSeat(params: {
  seatNumber: number;
  userId: string;
  eventId?: string;
  idempotencyKey?: string;
}): Promise<BookResult> {
  const seat = await findSeat(params.seatNumber, params.eventId);
  if (!seat) return { status: 'NOT_FOUND' };

  const result = await withSeatLock(
    seat.id,
    async () => {
      try {
        return await prisma.$transaction(async (tx) => {
          const upd = await tx.seat.updateMany({
            where: { id: seat.id, version: seat.version, status: 'AVAILABLE' },
            data: { status: 'HELD', version: { increment: 1 } },
          });
          if (upd.count === 0) return { status: 'TAKEN' } as BookResult;

          await ensureUser(tx, params.userId);
          const expiresAt = new Date(Date.now() + config.holdTtlSeconds * 1000);
          const reservation = await tx.reservation.create({
            data: {
              seatId: seat.id,
              userId: params.userId,
              status: 'HELD',
              idempotencyKey: params.idempotencyKey ?? null,
              expiresAt,
            },
          });
          await tx.outboxEvent.create({
            data: {
              aggregateId: seat.id,
              type: 'SEAT_HELD',
              payload: {
                seatId: seat.id,
                seatNumber: seat.number,
                userId: params.userId,
                reservationId: reservation.id,
                expiresAt: expiresAt.toISOString(),
              },
            },
          });
          return {
            status: 'HELD',
            reservationId: reservation.id,
            expiresAt: expiresAt.toISOString(),
          } as BookResult;
        });
      } catch (e) {
        if (isUniqueViolation(e)) return { status: 'TAKEN' } as BookResult;
        throw e;
      }
    },
    (): BookResult => ({ status: 'CONTENDED' })
  );

  if (result.status === 'HELD') {
    await redis.set(`hold:seat:${seat.id}`, result.reservationId, 'EX', config.holdTtlSeconds);
  }
  return result;
}

/** Phase 2: HELD -> BOOKED, only by the holder and before expiry. */
export async function confirmReservation(params: {
  reservationId: string;
  userId: string;
}): Promise<BookResult> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: params.reservationId },
  });
  if (!reservation) return { status: 'NOT_FOUND' };
  if (reservation.userId !== params.userId) return { status: 'FORBIDDEN' };
  if (reservation.status === 'CONFIRMED') {
    const existing = await prisma.booking.findUnique({ where: { seatId: reservation.seatId } });
    return { status: 'CONFIRMED', bookingId: existing?.id ?? '' };
  }
  if (reservation.status !== 'HELD' || reservation.expiresAt.getTime() < Date.now()) {
    return { status: 'EXPIRED' };
  }

  return withSeatLock(
    reservation.seatId,
    async () => {
      try {
        const out = await prisma.$transaction(async (tx) => {
          const upd = await tx.seat.updateMany({
            where: { id: reservation.seatId, status: 'HELD' },
            data: { status: 'BOOKED', version: { increment: 1 } },
          });
          if (upd.count === 0) return { status: 'EXPIRED' } as BookResult;

          const booking = await tx.booking.create({
            data: { userId: params.userId, seatId: reservation.seatId },
          });
          await tx.reservation.update({
            where: { id: reservation.id },
            data: { status: 'CONFIRMED' },
          });
          await tx.outboxEvent.create({
            data: {
              aggregateId: reservation.seatId,
              type: 'SEAT_BOOKED',
              payload: {
                seatId: reservation.seatId,
                userId: params.userId,
                bookingId: booking.id,
              },
            },
          });
          return { status: 'CONFIRMED', bookingId: booking.id } as BookResult;
        });
        return out;
      } catch (e) {
        if (isUniqueViolation(e)) return { status: 'TAKEN' } as BookResult;
        throw e;
      } finally {
        await redis.del(`hold:seat:${reservation.seatId}`);
      }
    },
    (): BookResult => ({ status: 'CONTENDED' })
  );
}

/** Sweeper: HELD reservations past their TTL go back to AVAILABLE. */
export async function releaseExpired(): Promise<number> {
  const expired = await prisma.reservation.findMany({
    where: { status: 'HELD', expiresAt: { lt: new Date() } },
    take: 100,
  });

  let released = 0;
  for (const r of expired) {
    await withSeatLock(
      r.seatId,
      async () => {
        await prisma.$transaction(async (tx) => {
          const upd = await tx.seat.updateMany({
            where: { id: r.seatId, status: 'HELD' },
            data: { status: 'AVAILABLE', version: { increment: 1 } },
          });
          await tx.reservation.update({ where: { id: r.id }, data: { status: 'EXPIRED' } });
          if (upd.count > 0) {
            await tx.outboxEvent.create({
              data: {
                aggregateId: r.seatId,
                type: 'SEAT_RELEASED',
                payload: { seatId: r.seatId, reservationId: r.id },
              },
            });
          }
        });
        await redis.del(`hold:seat:${r.seatId}`);
        released++;
      },
      () => undefined
    );
  }

  reservationsActive.set(await prisma.reservation.count({ where: { status: 'HELD' } }));
  return released;
}
