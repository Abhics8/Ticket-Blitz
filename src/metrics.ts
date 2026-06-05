import client from 'prom-client';

/**
 * Prometheus metrics. Exposed at GET /metrics and scraped by Prometheus
 * (see observability/prometheus.yml). The Grafana dashboard reads these.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const bookingsTotal = new client.Counter({
  name: 'tb_bookings_total',
  help: 'Booking attempts by outcome',
  labelNames: ['endpoint', 'result'] as const,
  registers: [registry],
});

export const bookingLatency = new client.Histogram({
  name: 'tb_booking_latency_seconds',
  help: 'End-to-end booking latency',
  labelNames: ['endpoint'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.087, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const lockContention = new client.Counter({
  name: 'tb_lock_contention_total',
  help: 'Distributed-lock acquisition failures (a request lost the race)',
  registers: [registry],
});

// Tripwire: the unique constraint makes this physically impossible, so it must
// stay at 0. The load test asserts on it.
export const oversellTotal = new client.Counter({
  name: 'tb_oversell_total',
  help: 'Detected oversells — MUST remain 0',
  registers: [registry],
});

export const reservationsActive = new client.Gauge({
  name: 'tb_reservations_active',
  help: 'Seats currently in HELD state',
  registers: [registry],
});

export const waitingRoomDepth = new client.Gauge({
  name: 'tb_waiting_room_depth',
  help: 'Users currently in the virtual waiting room',
  registers: [registry],
});

export const dlqTotal = new client.Counter({
  name: 'tb_dlq_total',
  help: 'Messages routed to the dead-letter topic',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const rateLimited = new client.Counter({
  name: 'tb_rate_limited_total',
  help: 'Requests rejected by the rate limiter',
  registers: [registry],
});
