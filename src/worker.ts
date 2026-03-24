import './tracing';
import { Kafka } from 'kafkajs';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379
});

const kafka = new Kafka({
    clientId: 'ticket-blitz-worker',
    brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']
});

const consumer = kafka.consumer({ groupId: 'booking-group' });

async function processBooking(userId: string, seatNumber: number) {
    const lockKey = `lock:seat:${seatNumber}`;
    const lockTTL = 5;

    // 1. ACQUIRE LOCK
    // @ts-ignore
    const acquired = await redis.set(lockKey, userId, 'NX', 'EX', lockTTL);

    if (!acquired) {
        console.log(`[Worker] Seat ${seatNumber} Locked. Retrying or Ignoring.`);
        // In a real system, we might push to a "retry-topic" with a delay.
        // For now, we drop it.
        return;
    }

    try {
        const seat = await prisma.seat.findFirst({ where: { number: seatNumber } });
        if (!seat || seat.status !== "AVAILABLE") {
            console.log(`[Worker] Seat ${seatNumber} Unavailable.`);
            // Release lock early?
            return;
        }

        // Simulate Processing
        await new Promise(r => setTimeout(r, 50));

        await prisma.user.upsert({
            where: { email: userId },
            update: {},
            create: { id: userId, email: userId, name: "Worker User" }
        });

        await prisma.seat.update({ where: { id: seat.id }, data: { status: "BOOKED" } });
        await prisma.booking.create({ data: { userId, seatId: seat.id } });

        // PUBLISH EVENT (For Real-time UI)
        await redis.publish('seat-updates', JSON.stringify({ seatNumber, status: "BOOKED" }));

        console.log(`[Worker] SUCCESS: Booked Seat ${seatNumber} for ${userId}`);

    } catch (e) {
        console.error("[Worker] Error:", e);
    } finally {
        const unlockScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;
        // @ts-ignore
        await redis.eval(unlockScript, 1, lockKey, userId);
    }
}

export const runWorker = async () => {
    await consumer.connect();
    await consumer.subscribe({ topic: 'booking-requests', fromBeginning: true });

    console.log("Worker Listening...");

    await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            if (!message.value) return;
            const payload = JSON.parse(message.value.toString());
            await processBooking(payload.userId, payload.seatNumber);
        },
    });
};

if (process.env.SINGLE_PROCESS !== 'true' && require.main === module) {
    runWorker().catch(console.error);
}
