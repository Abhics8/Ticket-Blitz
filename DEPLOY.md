# Deploying TicketBlitz (live demo)

The booking demo needs **Postgres + Redis**. Kafka and the worker are optional
(they drive async side-effects, not the booking itself), so the simplest live
demo is **API on Render + Postgres on Render + Redis on Upstash**. ~15 minutes.

## 1. Redis (Upstash — free)
1. Create a database at https://console.upstash.com → **Redis** → free tier.
2. Copy the connection string (looks like `rediss://default:********@xxx.upstash.io:6379`).

## 2. Backend API + Postgres (Render — free)
This repo ships a `render.yaml` blueprint (web service + free Postgres).

1. https://dashboard.render.com → **New → Blueprint** → connect `Abhics8/Ticket-Blitz`,
   choose this branch.
2. Render reads `render.yaml`: it creates `ticket-blitz-db` (Postgres) and the
   `ticket-blitz-api` web service, and wires `DATABASE_URL` automatically.
3. When prompted for the secret env var, paste your Upstash URL into **`REDIS_URL`**.
4. Deploy. On boot the service runs `prisma migrate deploy` and **auto-seeds 100 seats**
   (`AUTO_SEED=true`, `SEAT_COUNT=100`).

**Verify:**
```bash
curl https://<your-api>.onrender.com/health        # {"status":"ok",...}
curl https://<your-api>.onrender.com/api/seats | head   # 100 AVAILABLE seats
```

## 3. Point the frontend at the API (Vercel)
1. Vercel project for `ticket-blitz` → **Settings → Environment Variables**.
2. Set `VITE_API_URL = https://<your-api>.onrender.com` (no trailing slash).
3. **Redeploy** the frontend (env vars are baked in at build time).

Open the Vercel URL and book a seat — **Available** now counts down, and the
backend's `/api/seats` reflects it. Open two tabs to watch real-time updates.

## Notes
- **Free-tier sleep:** Render free services sleep after ~15 min idle; the first
  request then takes ~30–60s to wake. Hit `/health` to pre-warm, or upgrade for
  always-on. (The frontend now shows "Backend unreachable — is the API awake?"
  instead of failing silently.)
- **CORS** allows `*.vercel.app`, `localhost:5173`, and `FRONTEND_URL` if set.
- **Adding Kafka later:** provision a broker (Redpanda Serverless), set
  `KAFKA_BROKERS`, and run a second service with `node dist/worker.js` to enable
  the outbox relay, event consumer, DLQ, and reservation sweeper.

## Local (full stack, incl. Kafka)
```bash
npm run infra:up          # Postgres + Redis + Redpanda + Jaeger + Prometheus + Grafana
npm run db:migrate && npm run db:seed
PORT=3000 npm run dev:api          # + npm run dev:worker
npm run test:race && npm run verify:oversell   # prove zero oversell
```
