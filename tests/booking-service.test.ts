/**
 * Unit tests for the core correctness logic. Prisma, Redis and the distributed
 * lock are mocked so we can prove the three-layer behaviour deterministically,
 * with no infrastructure.
 */
import { Prisma } from '@prisma/client';

const mockLock = {
  acquire: jest.fn().mockResolvedValue(true),
  release: jest.fn().mockResolvedValue(true),
};
const mockPrisma: any = {
  seat: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};
const mockRedis = { set: jest.fn(), del: jest.fn() };

jest.mock('../src/lib/redis-lock', () => ({ DistributedLock: jest.fn(() => mockLock) }));
jest.mock('../src/lib/db', () => ({ prisma: mockPrisma }));
jest.mock('../src/lib/redis', () => ({ redis: mockRedis }));

import { bookSeat } from '../src/services/booking-service';

function makeTx(overrides: Partial<Record<string, any>> = {}) {
  return {
    seat: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    user: { upsert: jest.fn().mockResolvedValue({}) },
    booking: { create: jest.fn().mockResolvedValue({ id: 'booking-1' }) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

describe('bookSeat — three-layer concurrency safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLock.acquire.mockResolvedValue(true);
    mockPrisma.seat.findFirst.mockResolvedValue({
      id: 'seat-1',
      number: 1,
      version: 0,
      status: 'AVAILABLE',
    });
  });

  test('books the seat when the version CAS wins (count = 1)', async () => {
    const tx = makeTx();
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await bookSeat({ seatNumber: 1, userId: 'u1' });

    expect(result).toEqual({ status: 'BOOKED', bookingId: 'booking-1' });
    expect(tx.seat.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'seat-1', version: 0, status: 'AVAILABLE' },
      })
    );
    expect(mockLock.release).toHaveBeenCalled(); // lock always released
  });

  test('returns TAKEN when the version CAS loses (count = 0)', async () => {
    const tx = makeTx({ seat: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } });
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await bookSeat({ seatNumber: 1, userId: 'u1' });

    expect(result).toEqual({ status: 'TAKEN' });
    expect(tx.booking.create).not.toHaveBeenCalled();
  });

  test('returns TAKEN when the unique constraint backstop fires (P2002)', async () => {
    const tx = makeTx({
      booking: {
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('dupe', {
            code: 'P2002',
            clientVersion: 'test',
          })
        ),
      },
    });
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await bookSeat({ seatNumber: 1, userId: 'u1' });

    expect(result).toEqual({ status: 'TAKEN' });
  });

  test('returns CONTENDED when the distributed lock cannot be acquired', async () => {
    mockLock.acquire.mockResolvedValue(false);

    const result = await bookSeat({ seatNumber: 1, userId: 'u1' });

    expect(result).toEqual({ status: 'CONTENDED' });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('returns NOT_FOUND for an unknown seat', async () => {
    mockPrisma.seat.findFirst.mockResolvedValue(null);

    const result = await bookSeat({ seatNumber: 999, userId: 'u1' });

    expect(result).toEqual({ status: 'NOT_FOUND' });
  });
});
