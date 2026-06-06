# System Design — TicketBlitz

> A reference doc for understanding the engineering decisions behind each layer of the booking system. Written to answer the questions that come up in system-design interviews.

---

## 1. Problem Statement

Sell each seat **exactly once** when thousands of people click "Buy" simultaneously.

The naive failure mode:

```
T=0ms  Request A: SELECT seat → AVAILABLE   Request B: SELECT seat → AVAILABLE
T=1ms  Request A: UPDATE seat → BOOKED      Request B: UPDATE seat → BOOKED  ← oversold!
```

This is a classic TOCTOU (time-of-check/time-of-use) race. The solution needs to be correct under:
- Multiple API instances running in parallel
- Partial failures (API crash mid-transaction, Redis timeout, Kafka broker down)
- Adversarial load (scalper bots hammering a single endpoint)

---

## 2. High-Level Architecture

```
Clients (browser / k6)
       │ HTTP + WebSocket
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Fastify API  (stateless, N instances behind a load balancer) │
│  • Rate limiter (Redis Lua token-bucket, atomic, cross-node)  │
│  • Idempotency replay (Redis, 24h TTL)                        │
│  • Waiting room gate (Redis FIFO sorted set)                  │
│  • Booking logic  ──────────────────────────────────────────► │
│      Layer 1: Redis distributed lock (SET NX EX + Lua del)   │
│      Layer 2: Postgres CAS  (UPDATE … WHERE version = ?)     │
│      Layer 3: UNIQUE constraint (Booking.seatId)             │
│  • Outbox write  (same transaction as booking)               │
└──────────────────────────────────────────────────────────────┘
       │ Prisma / pg           │ ioredis           │ Socket.IO
       ▼                       ▼                   ▼
┌────────────┐         ┌─────────────┐     ┌───────────────────┐
│ PostgreSQL │         │   Redis     │     │ Socket.IO Redis   │
│ Seat       │         │ • locks     │     │ adapter           │
│ Booking    │         │ • rate-lim  │     │ (pub/sub fan-out  │
│ Reservation│         │ • idem keys │     │  across instances)│
│ OutboxEvent│         │ • wait room │     └───────────────────┘
└────────────┘         └─────────────┘
       │ outbox poll
       ▼
┌──────────────────────────────────┐
│  Worker (single process)        │
│  • Outbox relay → Kafka/Redpanda │
│  • Kafka consumer (event-id dedup│
│  • DLQ for poison messages      │
│  • Reservation expiry sweeper   │
└──────────────────────────────────┘
       │                │
       ▼                ▼
┌──────────┐     ┌─────────────┐
│  Kafka   │     │    DLQ      │
│ /Redpanda│     │   topic     │
└──────────┘     └─────────────┘

Observability: Prometheus /metrics → Grafana · OpenTelemetry OTLP → Jaeger
```

---

## 3. Why Three Concurrency Layers?

### The core argument: defence in depth

Each layer is independently sufficient to prevent an oversell. Together they form a fault-tolerant chain — the system is correct even if any one layer fails.

---

### Layer 1 — Redis Distributed Lock (Pessimistic)

```typescript
// redis-lock.ts
const result = await redis.set(lockKey, token, 'EX', ttlSeconds, 'NX');
// NX = set only if Not eXists → atomic, correct across all API instances
```

**What it solves:** Serialises the critical section across N API instances. Without it, two requests on different servers both read `AVAILABLE`, both write `BOOKED`.

**Why Redis and not a Postgres advisory lock?**  
Postgres advisory locks are connection-scoped — they can't span multiple API processes in a connection-pooled environment without careful management. Redis `SET NX EX` is atomic, connection-independent, and auto-expires (so a crashed holder never holds the lock forever).

**Why a Lua script for release?**
```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
```
This check-then-delete is a single atomic op. Without it, a slow request could release a lock that was already acquired by a different request after the first one's TTL expired — a classic ABA problem.

**What can still go wrong:** Redis itself can crash, or the lock TTL expires mid-transaction if the DB is slow. That's why there are two more layers.

---

### Layer 2 — Version-Column Compare-and-Swap (Optimistic)

```typescript
// booking-service.ts
const upd = await tx.seat.updateMany({
  where: { id: seat.id, version: seat.version, status: 'AVAILABLE' },
  data:  { status: 'BOOKED', version: { increment: 1 } },
});
if (upd.count === 0) return { status: 'TAKEN' };
```

**What it solves:** Lost updates. If the Redis lock TTL expires mid-transaction and another request acquires the lock, the CAS fails (`count = 0`) because the version changed. No double-booking is possible.

**Why not `SELECT FOR UPDATE` (row-level locking)?**  
`SELECT FOR UPDATE` holds a row lock for the entire transaction duration. Under high concurrency this creates lock queuing in Postgres, leading to cascading timeouts. CAS is non-blocking — the second writer fails fast and retries rather than waiting.

**Tradeoff:** CAS can starve under extreme contention (request keeps losing the race). In practice, the Redis lock already serialises writers, so CAS is almost always a backstop rather than a primary path.

---

### Layer 3 — Database UNIQUE Constraint (Final Backstop)

```prisma
model Booking {
  seatId String @unique  // Postgres CANNOT store two bookings for one seat
}
```

**What it solves:** Every edge case that the first two layers missed — network partition, ORM bug, future code that bypasses the service layer. Postgres itself enforces uniqueness. A duplicate raises `P2002`, which the service maps to a `409`.

**Why this matters:** Application-level correctness guarantees are only as good as the code. Database constraints are enforced by the engine regardless of application bugs.

---

## 4. Why a Transactional Outbox Instead of Direct Kafka Publish?

### The dual-write problem

The naive approach:
```typescript
await prisma.booking.create(...)   // Step 1 — write to DB
await kafka.producer.send(...)     // Step 2 — publish event
```

If the process crashes between step 1 and step 2, the booking exists in Postgres but no downstream system (notifications, analytics, audit) ever knows. Events are silently lost.

If you reverse the order, you publish an event for a booking that might never commit.

### The outbox pattern

```typescript
// Inside the SAME Prisma transaction as the booking:
await tx.booking.create({ ... });
await tx.outboxEvent.create({
  type: 'SEAT_BOOKED',
  payload: { bookingId, seatId, userId },
  status: 'PENDING',
});
// If this transaction commits, BOTH the booking and the event exist atomically.
// If it rolls back, neither exists.
```

A separate **outbox relay** polls `OutboxEvent WHERE status = 'PENDING'` and publishes to Kafka, then marks `status = 'PUBLISHED'`. With an idempotent Kafka producer and a consumer that deduplicates on `event.id`, this gives **effectively-once delivery** — even if the relay crashes and replays.

**The key invariant:** Domain events are only ever published for bookings that actually committed. Lost-event bugs become impossible by construction.

---

## 5. Why a FIFO Waiting Room?

### The thundering herd problem

During a popular onsale (Taylor Swift, NFL playoffs), traffic can spike 1000× in seconds. Without admission control, every request hits the booking layer simultaneously:
- Redis lock contention spikes → most requests fail with `CONTENDED`
- Postgres connection pool saturates
- P95 latency explodes
- Users retry, making it worse

### The waiting room

```typescript
// waiting-room.ts
await redis.zadd(QUEUE(event), 'NX', Date.now(), userId);
// Score = join timestamp → FIFO ordering

// Worker admits N users/tick into the ADMITTED set:
const users = await redis.zrange(QUEUE(event), 0, admitPerTick - 1);
```

Users are queued in a Redis sorted set (score = join timestamp = FIFO). A worker promotes the front N users/second into an `ADMITTED` set. Only admitted users reach the booking layer.

**Benefits:**
- The booking layer sees controlled, steady load regardless of spike size
- Users get a real position number (fair, transparent)
- Scalper bots see the same queue — the rate limiter handles them before this point

**Why Redis sorted set and not a message queue?**  
Position queries (`ZRANK`) are O(log N) and work across instances. A message queue doesn't support "what is my current position?" without extra state.

---

## 6. Two-Phase Booking: Reserve → Confirm

Real ticketing systems don't book immediately on click — they **hold** the seat for ~10 minutes while the user completes payment.

```
POST /api/reserve  → seat: AVAILABLE → HELD (TTL 10min), returns reservationId
POST /api/confirm  → seat: HELD → BOOKED (after payment completes)
                     or sweeper: HELD → AVAILABLE (if TTL expires)
```

**Why not just hold at payment time?**  
Users need to know the seat is theirs before entering credit card details. A `HELD` state prevents another buyer from taking it mid-checkout without permanently committing inventory.

**The sweeper:**  
The worker polls `Reservation WHERE status = HELD AND expiresAt < NOW()` every N seconds and releases expired holds back to `AVAILABLE`. Uses the same 3-layer correctness for the release as for the initial booking.

---

## 7. Scale Analysis — What Breaks First at 100K Concurrent Users?

### Current architecture limits

| Component | Bottleneck | Estimated limit | Why |
|-----------|-----------|-----------------|-----|
| **Redis lock per seat** | Single-key contention | ~5K–10K req/s per seat | `SET NX` is O(1) but all contenders queue on the same key |
| **Postgres connections** | Connection pool (default: 10–20 per instance) | ~1K–2K req/s per instance | Each booking opens a short transaction; pool exhaustion causes queueing |
| **Fastify API (single instance)** | Node.js event loop | ~5K–10K req/s | I/O-bound (Redis + Postgres round-trips dominate) |
| **Socket.IO fan-out** | Redis pub/sub | ~50K connected clients per Redis node | Message fan-out is O(connected sockets) |
| **Outbox relay (single worker)** | Kafka produce throughput | ~20K events/s | Batched produce; only real limit at scale |

### What actually breaks first

At 100K concurrent users, the **Postgres connection pool** is the first failure point, followed by **Redis lock contention on the hottest seat**.

### How to scale past it

1. **Horizontal API scaling** — already stateless; K8s HPA in [`k8s/hpa.yaml`](k8s/hpa.yaml) handles this. Each new instance adds ~5K–10K req/s capacity.

2. **PgBouncer connection pooler** — sits between API instances and Postgres, multiplexing thousands of application connections onto a small number of real Postgres connections. This alone 10×s Postgres throughput.

3. **Per-event seat sharding** — instead of one Redis key per seat, shard the lock namespace by `eventId` so different events don't contend. Already implemented: `lock:seat:${seatId}` uses the seat UUID, which is naturally distributed.

4. **Read replicas for `GET /api/seats`** — seat availability reads can go to a Postgres read replica; only writes hit the primary.

5. **Kafka partition scaling** — add partitions for high-volume events; consumer group rebalances automatically.

### The one thing that doesn't scale horizontally

The **virtual waiting room admission ticker** runs in the worker process. A single Node.js process can admit ~50K–100K users/sec (Redis ZRANGE is the limit), which is sufficient for most onsales. For true planet-scale (Super Bowl: millions of concurrent), you'd promote the admission logic to a dedicated horizontally-scaled service.

---

## 8. Token-Bucket Rate Limiter — Why Lua?

```lua
-- rate-limiter.ts (atomic Lua script)
local tokens = math.min(capacity, tokens + elapsed * refill)
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
```

**Why not an in-memory rate limiter?** With N API instances, each instance has its own counter — a bot can make N-1 extra requests by hitting all instances once each.

**Why Lua and not a Redis transaction?** A `WATCH/MULTI/EXEC` transaction retries on conflict. Under high load this creates many retries. The Lua script runs server-side as a single atomic operation — no round-trips, no retries, O(1) regardless of concurrency.

---

## 9. Idempotency — Why It Matters for Booking

```typescript
// idempotency.ts
const cached = await redis.get(`idem:${key}`);
if (cached) return JSON.parse(cached);  // replay the original response
```

Mobile clients and load balancers retry failed requests. Without idempotency, a network timeout that causes a retry books the same seat twice. With idempotency keys, the second request replays the first response from cache — the user sees success without a double-booking.

**Key design:** The idempotency store is in Redis with a 24h TTL. The key is set *after* the booking completes, not before — this prevents a race where a pre-emptive cache hit blocks a legitimate first booking.

---

## 10. Observability — What to Monitor

| Metric | Alert threshold | Meaning |
|--------|----------------|---------|
| `tb_oversell_total` | > 0 (ever) | A seat was booked twice — P0 incident |
| `tb_lock_contention_total` rate | > 20% of booking attempts | Redis lock pressure; scale API instances |
| `tb_booking_latency_seconds p95` | > 200ms | DB or Redis degradation |
| `tb_dlq_total` rate | > 0 sustained | Kafka consumer errors; investigate payload |
| `tb_reservations_active` | > totalSeats × 0.9 | Nearly all seats held; sweeper may be lagging |
| `tb_rate_limited_total` rate | spike | Bot activity or legitimate surge |
| `tb_waiting_room_depth` | sustained growth | Admission rate too low for demand |

---

## 11. Key Tradeoffs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Concurrency | 3-layer (lock + CAS + constraint) | Single advisory lock | Defence in depth; correct under partial failure |
| Messaging | Transactional outbox → Kafka | Direct Kafka publish | Eliminates dual-write; exactly-once by construction |
| Rate limiting | Redis Lua token bucket | In-memory per-instance | Correct across N API instances |
| Waiting room | Redis FIFO sorted set | Message queue | O(log N) position queries; works cross-instance |
| Booking flow | Two-phase (reserve + confirm) | Immediate booking | Matches real payment flow; holds inventory fairly |
| Schema lock | UNIQUE constraint | Application-only | Engine-enforced; survives application bugs |

---

*Last updated: June 2026 · See [`src/services/booking-service.ts`](src/services/booking-service.ts) for the implementation and [`tests/booking-service.test.ts`](tests/booking-service.test.ts) for proof of each layer.*
