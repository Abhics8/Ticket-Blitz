import { z } from 'zod';

export const BookingMessageSchema = z.object({
  userId: z.string(),
  seatId: z.number(),
  action: z.enum(['RESERVE', 'RELEASE', 'CONFIRM']),
  timestamp: z.number()
});

export type BookingMessage = z.infer<typeof BookingMessageSchema>;

export class KafkaSerializer {
  static serialize(message: BookingMessage): Buffer {
    // Validate schema before producing to Kafka to prevent poison pills
    BookingMessageSchema.parse(message);
    return Buffer.from(JSON.stringify(message));
  }

  static deserialize(buffer: Buffer | null): BookingMessage {
    if (!buffer) {
        throw new Error("Cannot deserialize null buffer");
    }
    const parsed = JSON.parse(buffer.toString('utf-8'));
    // Strict runtime validation when consuming
    return BookingMessageSchema.parse(parsed);
  }
}
