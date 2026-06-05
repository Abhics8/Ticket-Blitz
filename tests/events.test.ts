import { serialize, parse, DomainEvent } from '../src/lib/events';

describe('domain event (de)serialization', () => {
  const event: DomainEvent = {
    id: 'evt-1',
    aggregateId: 'seat-1',
    type: 'SEAT_BOOKED',
    payload: { seatNumber: 1, userId: 'u1' },
    createdAt: new Date().toISOString(),
  };

  test('round-trips a valid event', () => {
    expect(parse(serialize(event))).toEqual(event);
  });

  test('rejects a poison-pill message', () => {
    expect(() => parse(Buffer.from(JSON.stringify({ bad: 'data' })))).toThrow();
  });

  test('rejects an empty message', () => {
    expect(() => parse(null)).toThrow();
  });
});
