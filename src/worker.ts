import './tracing';
import { config } from './config';
import { makeConsumer, getProducer, ensureTopics } from './lib/kafka';
import { parse, DomainEvent } from './lib/events';
import { startOutboxRelay } from './lib/outbox';
import { releaseExpired } from './services/booking-service';
import { admitBatch } from './lib/waiting-room';
import { redis } from './lib/redis';
import { dlqTotal } from './metrics';

/**
 * Side-effect worker. Three responsibilities:
 *   1. Outbox relay        — publish committed domain events to Kafka.
 *   2. Event consumer      — react to events (analytics/notifications/audit),
 *                            idempotently, with a dead-letter topic for poison
 *                            and handler failures.
 *   3. Reservation sweeper — expire stale HELD seats back to AVAILABLE.
 *
 * Real-time UI fan-out is NOT done here — the API tier owns that via the
 * Socket.IO Redis adapter, which avoids duplicate broadcasts.
 */

async function handleEvent(event: DomainEvent): Promise<void> {
  // Idempotent consumer: SET NX means we process each event id exactly once,
  // even though the outbox guarantees only at-least-once delivery.
  const fresh = await redis.set(`evt:${event.id}`, '1', 'EX', 3600, 'NX');
  if (fresh !== 'OK') return;

  // Side effects would go here (email, analytics rollups, audit log).
  // Intentionally light — the point is the delivery guarantees around it.
  console.log(`[worker] processed ${event.type} seat=${event.aggregateId}`);
}

async function runConsumer(): Promise<void> {
  const consumer = makeConsumer('booking-side-effects');
  const producer = await getProducer();
  await consumer.connect();
  await consumer.subscribe({ topic: config.topics.bookingEvents, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      let event: DomainEvent;
      try {
        event = parse(message.value);
      } catch (err) {
        // Poison pill: route to DLQ instead of crash-looping the consumer.
        dlqTotal.inc({ reason: 'poison' });
        await producer.send({
          topic: config.topics.dlq,
          messages: [{ value: message.value ?? Buffer.from('null'), headers: { error: String(err) } }],
        });
        return;
      }

      try {
        await handleEvent(event);
      } catch (err) {
        dlqTotal.inc({ reason: 'handler' });
        await producer.send({
          topic: config.topics.dlq,
          messages: [{ key: event.aggregateId, value: message.value!, headers: { error: String(err) } }],
        });
      }
    },
  });
}

async function main(): Promise<void> {
  await ensureTopics();
  startOutboxRelay();

  setInterval(() => {
    releaseExpired().catch((e) => console.error('[sweeper] error:', e));
  }, config.sweepMs);

  if (config.waitingRoom.enabled) {
    setInterval(() => {
      admitBatch('default').catch(() => undefined);
    }, config.waitingRoom.tickMs);
  }

  await runConsumer();
  console.log('[worker] running — outbox relay + consumer + sweeper');
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
