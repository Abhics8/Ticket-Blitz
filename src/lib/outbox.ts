import { prisma } from './db';
import { getProducer } from './kafka';
import { config } from '../config';
import { serialize, DomainEvent } from './events';

/**
 * Transactional outbox relay. Polls OutboxEvent rows that were written in the
 * same DB transaction as the booking, publishes them to Kafka, then marks them
 * PUBLISHED. Because the producer is idempotent and the consumer dedupes by
 * event id, this gives effectively-once delivery without the dual-write bug.
 */
export async function relayOnce(): Promise<number> {
  const pending = await prisma.outboxEvent.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  if (pending.length === 0) return 0;

  const producer = await getProducer();
  for (const e of pending) {
    const event: DomainEvent = {
      id: e.id,
      aggregateId: e.aggregateId,
      type: e.type as DomainEvent['type'],
      payload: (e.payload ?? {}) as Record<string, unknown>,
      createdAt: e.createdAt.toISOString(),
    };
    // key = aggregateId -> all events for one seat land on the same partition,
    // preserving per-seat ordering.
    await producer.send({
      topic: config.topics.bookingEvents,
      messages: [{ key: e.aggregateId, value: serialize(event) }],
    });
    await prisma.outboxEvent.update({
      where: { id: e.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
  }
  return pending.length;
}

export function startOutboxRelay(): NodeJS.Timeout {
  return setInterval(() => {
    relayOnce().catch((err) => console.error('[outbox] relay error:', err));
  }, config.outboxPollMs);
}
