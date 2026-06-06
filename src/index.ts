import './tracing';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { z } from 'zod';

import { config } from './config';
import { prisma } from './lib/db';
import { pubClient, subClient } from './lib/redis';
import * as booking from './services/booking-service';
import type { BookResult } from './services/booking-service';
import * as idem from './lib/idempotency';
import * as rl from './lib/rate-limiter';
import * as waitingRoom from './lib/waiting-room';
import { registry, bookingsTotal, bookingLatency, rateLimited } from './metrics';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
let io: Server | undefined;

declare module 'fastify' {
  interface FastifyInstance {
    io?: Server;
  }
}

// ---- validation ----
const BookSchema = z.object({
  userId: z.string().min(1),
  seatNumber: z.number().int(),
  eventId: z.string().optional(),
});
const ConfirmSchema = z.object({
  reservationId: z.string().min(1),
  userId: z.string().min(1),
});

// ---- helpers ----
const HTTP: Record<BookResult['status'], number> = {
  BOOKED: 200,
  HELD: 200,
  CONFIRMED: 200,
  TAKEN: 409,
  CONTENDED: 409,
  NOT_FOUND: 404,
  EXPIRED: 410,
  FORBIDDEN: 403,
};

function clientKey(req: FastifyRequest, userId: string): string {
  return `${req.ip}:${userId}`;
}

function toHttp(endpoint: string, r: BookResult, seatNumber?: number) {
  bookingsTotal.inc({ endpoint, result: r.status });
  return { code: HTTP[r.status] ?? 200, body: { ...r, seatNumber } };
}

/** Replay the original response for a repeated Idempotency-Key. */
async function runIdempotent(
  key: string | undefined,
  fn: () => Promise<{ code: number; body: unknown }>
): Promise<{ code: number; body: unknown }> {
  if (!key) return fn();
  const cached = await idem.getCached<{ code: number; body: unknown }>(key);
  if (cached) return cached;
  if (!(await idem.acquireProcessing(key))) {
    await new Promise((r) => setTimeout(r, 150));
    const again = await idem.getCached<{ code: number; body: unknown }>(key);
    if (again) return again;
  }
  try {
    const res = await fn();
    await idem.store(key, res);
    return res;
  } finally {
    await idem.releaseProcessing(key);
  }
}

function emitSeat(seatNumber: number | undefined, status: string) {
  if (io && seatNumber !== undefined) io.emit('seat-update', { seatNumber, status });
}

// ---- routes ----
app.get('/health', async () => ({ status: 'ok', instance: config.instanceId, ts: new Date().toISOString() }));

app.get('/metrics', async (_req, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

app.get('/api/seats', async () =>
  prisma.seat.findMany({ orderBy: { number: 'asc' } })
);

app.get('/api/random-seat', async () =>
  prisma.seat.findFirst({ where: { status: 'AVAILABLE' } })
);

/**
 * Correct one-shot booking. Rate-limited, idempotent, waiting-room gated, and
 * backed by the three-layer concurrency safety in booking-service.
 */
const bookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const parsed = BookSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
  const { userId, seatNumber, eventId } = parsed.data;

  if (!(await rl.allow(clientKey(req, userId)))) {
    rateLimited.inc();
    return reply.code(429).send({ error: 'rate limited' });
  }
  if (config.waitingRoom.enabled && eventId && !(await waitingRoom.isAdmitted(eventId, userId))) {
    return reply.code(425).send({ error: 'in waiting room', position: await waitingRoom.position(eventId, userId) });
  }

  const key = (req.headers['idempotency-key'] as string) || undefined;
  const stop = bookingLatency.startTimer({ endpoint: 'book' });
  const out = await runIdempotent(key, async () => {
    const result = await booking.bookSeat({ userId, seatNumber, eventId });
    return toHttp('book', result, seatNumber);
  });
  stop();

  const status = (out.body as BookResult).status;
  if (status === 'BOOKED') emitSeat(seatNumber, 'BOOKED');
  return reply.code(out.code).send(out.body);
};
app.post('/api/book', bookHandler);
// Back-compat alias — the original frontend posts to /api/book-async.
app.post('/api/book-async', bookHandler);

/** Phase 1 — hold a seat for config.holdTtlSeconds. */
app.post('/api/reserve', async (req, reply) => {
  const parsed = BookSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
  const { userId, seatNumber, eventId } = parsed.data;

  if (!(await rl.allow(clientKey(req, userId)))) {
    rateLimited.inc();
    return reply.code(429).send({ error: 'rate limited' });
  }

  const key = (req.headers['idempotency-key'] as string) || undefined;
  const stop = bookingLatency.startTimer({ endpoint: 'reserve' });
  const out = await runIdempotent(key, async () => {
    const result = await booking.reserveSeat({ userId, seatNumber, eventId, idempotencyKey: key });
    return toHttp('reserve', result, seatNumber);
  });
  stop();

  if ((out.body as BookResult).status === 'HELD') emitSeat(seatNumber, 'HELD');
  return reply.code(out.code).send(out.body);
});

/** Phase 2 — confirm a held seat. */
app.post('/api/confirm', async (req, reply) => {
  const parsed = ConfirmSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });

  const stop = bookingLatency.startTimer({ endpoint: 'confirm' });
  const result = await booking.confirmReservation(parsed.data);
  stop();

  const { code, body } = toHttp('confirm', result);
  if (result.status === 'CONFIRMED') emitSeat(undefined, 'BOOKED');
  return reply.code(code).send(body);
});

app.post('/api/waiting-room/join', async (req, reply) => {
  const body = z.object({ eventId: z.string(), userId: z.string() }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: 'invalid body' });
  const position = await waitingRoom.join(body.data.eventId, body.data.userId);
  return { position, admitted: await waitingRoom.isAdmitted(body.data.eventId, body.data.userId) };
});

app.get('/api/waiting-room/status', async (req, reply) => {
  const q = z.object({ eventId: z.string(), userId: z.string() }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: 'invalid query' });
  return {
    position: await waitingRoom.position(q.data.eventId, q.data.userId),
    admitted: await waitingRoom.isAdmitted(q.data.eventId, q.data.userId),
  };
});

/**
 * Intentionally broken endpoint, kept for the demo: it READs then WRITEs with
 * no lock, so concurrent requests double-book. Compare its load-test result to
 * /api/book to see the race condition the rest of this system prevents.
 */
app.post('/api/book-naive', async (req, reply) => {
  const parsed = BookSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid body' });
  const { userId, seatNumber } = parsed.data;
  const seat = await prisma.seat.findFirst({ where: { number: seatNumber } });
  if (!seat) return reply.code(404).send({ error: 'Seat not found' });
  if (seat.status !== 'AVAILABLE') return reply.code(409).send({ error: 'Seat already taken' });
  await new Promise((r) => setTimeout(r, 50)); // the gap where the race happens
  await prisma.user.upsert({ where: { email: userId }, update: {}, create: { id: userId, email: userId, name: 'Test User' } });
  await prisma.seat.update({ where: { id: seat.id }, data: { status: 'BOOKED' } });
  const b = await prisma.booking.create({ data: { userId, seatId: seat.id } }).catch(() => null);
  return { success: !!b, bookingId: b?.id };
});

// ---- bootstrap ----
async function ensureSeeded(): Promise<void> {
  if (!config.autoSeed) return;
  if ((await prisma.seat.count()) > 0) return;
  const event = await prisma.event.create({
    data: { name: 'The Eras Tour', date: new Date(), totalSeats: config.seatCount },
  });
  await prisma.seat.createMany({
    data: Array.from({ length: config.seatCount }, (_, i) => ({
      number: i + 1,
      row: 'A',
      status: 'AVAILABLE',
      eventId: event.id,
    })),
  });
  app.log.info(`auto-seeded ${config.seatCount} seats`);
}

async function main() {
  await app.register(cors, {
    origin: [/\.vercel\.app$/, 'http://localhost:5173', process.env.FRONTEND_URL || ''].filter(Boolean),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await ensureSeeded();

  const address = await app.listen({ port: config.port, host: '0.0.0.0' });

  io = new Server(app.server, { cors: { origin: '*' } });
  // Redis adapter -> a seat-update emitted on ANY instance reaches clients on
  // EVERY instance. Without this, real-time breaks the moment you scale past 1.
  try {
    io.adapter(createAdapter(pubClient, subClient));
  } catch {
    app.log.warn('Socket.IO Redis adapter disabled (single-instance fan-out only)');
  }
  io.on('connection', (s) => app.log.info(`socket connected ${s.id}`));

  app.log.info(`API ${config.instanceId} listening on ${address}`);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
