import { Kafka, Producer, Consumer, logLevel } from 'kafkajs';
import { config } from '../config';

export const kafka = new Kafka({
  clientId: 'ticket-blitz',
  brokers: config.kafkaBrokers,
  logLevel: logLevel.NOTHING,
});

let producer: Producer | null = null;

/**
 * Idempotent producer: maxInFlightRequests=1 + idempotent=true gives Kafka's
 * exactly-once producer semantics (no duplicates on retry, preserved order).
 */
export async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await producer.connect();
  }
  return producer;
}

export function makeConsumer(groupId: string): Consumer {
  return kafka.consumer({ groupId });
}

/** Create topics up front so partitioning (ordering per seat) is deterministic. */
export async function ensureTopics(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  await admin
    .createTopics({
      topics: [
        { topic: config.topics.bookingEvents, numPartitions: 6 },
        { topic: config.topics.dlq, numPartitions: 1 },
      ],
    })
    .catch(() => undefined);
  await admin.disconnect();
}
