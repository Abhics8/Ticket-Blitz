import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

/**
 * CORRECTNESS test. Thousands of requests fight over a SINGLE seat. With the
 * distributed lock + version CAS + unique constraint, at most ONE may win.
 *
 * The `booked_success` threshold (count < 2) is the hard safety gate: if the
 * system ever oversells, this run fails. Pair with `npm run verify:oversell`
 * for a database-level confirmation.
 *
 *   k6 run load/race.js                 # 1 instance on :3000
 *   BASE_URL=http://localhost:3000 SEAT=1 k6 run load/race.js
 */
const booked = new Counter('booked_success');
const conflict = new Counter('booking_conflict');

export const options = {
  scenarios: {
    race: { executor: 'shared-iterations', vus: 100, iterations: 2000, maxDuration: '60s' },
  },
  thresholds: {
    booked_success: ['count<2'], // never oversell
    checks: ['rate>0.99'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SEAT = Number(__ENV.SEAT || 1);

export default function () {
  const res = http.post(
    `${BASE}/api/book`,
    JSON.stringify({ userId: `u-${__VU}-${__ITER}`, seatNumber: SEAT }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (res.status === 200) booked.add(1);
  else if (res.status === 409) conflict.add(1);

  check(res, {
    'no server error': (r) => r.status < 500,
    'booked or conflict': (r) => r.status === 200 || r.status === 409,
  });
}

export function handleSummary(data) {
  const wins = data.metrics.booked_success ? data.metrics.booked_success.values.count : 0;
  return {
    stdout: `\n  Seat ${SEAT}: ${wins} booking(s) succeeded (expected exactly 1, MUST be < 2).\n`,
  };
}
