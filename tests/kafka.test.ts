import { KafkaSerializer } from '../src/lib/kafka-utils';

describe('Kafka Serializer', () => {
  const validMessage = {
    userId: 'user123',
    seatId: 45,
    action: 'RESERVE' as const,
    timestamp: Date.now()
  };

  test('should serialize valid message to Buffer', () => {
    const buffer = KafkaSerializer.serialize(validMessage);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString()).toContain('user123');
  });

  test('should deserialize Buffer back to typed message', () => {
    const buffer = Buffer.from(JSON.stringify(validMessage));
    const decoded = KafkaSerializer.deserialize(buffer);
    expect(decoded.userId).toBe('user123');
    expect(decoded.action).toBe('RESERVE');
  });

  test('should throw Zod error on invalid serialization input', () => {
    const invalidMessage = {
      userId: 'user123',
      // seatId missing
      action: 'RESERVE',
      timestamp: Date.now()
    } as any;

    expect(() => KafkaSerializer.serialize(invalidMessage)).toThrow();
  });

  test('should throw Zod error on invalid deserialization (poison pill)', () => {
    const poisonBuffer = Buffer.from(JSON.stringify({ bad: 'data' }));
    expect(() => KafkaSerializer.deserialize(poisonBuffer)).toThrow();
  });
});
