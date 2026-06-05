import http from 'k6/http';
import { check } from 'k6';

/**
 * THROUGHPUT / latency test. VUs book distinct seats so contention is low and
 * we measure real serving latency and capacity. Seed enough seats first
 * (default range 5000).
 *
 *   SEATS=5000 BASE_URL=http://localhost:3000 k6 run load/throughput.js
 */
export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 200 },
        { duration: '20s', target: 200 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    checks: ['rate>0.99'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SEATS = Number(__ENV.SEATS || 5000);

export default function () {
  const seatNumber = ((__VU * 100000 + __ITER) % SEATS) + 1;
  const res = http.post(
    `${BASE}/api/book`,
    JSON.stringify({ userId: `u-${__VU}-${__ITER}`, seatNumber }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(res, { 'no server error': (r) => r.status < 500 });
}
