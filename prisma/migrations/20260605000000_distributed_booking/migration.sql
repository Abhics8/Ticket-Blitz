-- Reservation: two-phase HOLD -> CONFIRM/EXPIRE flow
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Reservation_idempotencyKey_key" ON "Reservation"("idempotencyKey");
CREATE INDEX "Reservation_seatId_idx" ON "Reservation"("seatId");
CREATE INDEX "Reservation_status_expiresAt_idx" ON "Reservation"("status", "expiresAt");

ALTER TABLE "Reservation"
    ADD CONSTRAINT "Reservation_seatId_fkey" FOREIGN KEY ("seatId")
    REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- OutboxEvent: transactional outbox for exactly-once event publishing
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt");

-- Index to speed up seat-status scans
CREATE INDEX "Seat_status_idx" ON "Seat"("status");
