import { z } from 'zod';

/**
 * Domain events that flow through Kafka. Validated with Zod on the way out
 * (in the outbox relay) and on the way in (the consumer), so a malformed
 * "poison pill" message is detected and routed to the DLQ instead of crashing
 * the consumer loop.
 */
export const DomainEventSchema = z.object({
  id: z.string(),
  aggregateId: z.string(),
  type: z.enum(['SEAT_HELD', 'SEAT_BOOKED', 'SEAT_RELEASED']),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export type DomainEvent = z.infer<typeof DomainEventSchema>;

export function serialize(event: DomainEvent): string {
  return JSON.stringify(event);
}

export function parse(raw: string | Buffer | null): DomainEvent {
  if (!raw) throw new Error('empty message');
  return DomainEventSchema.parse(JSON.parse(raw.toString()));
}
