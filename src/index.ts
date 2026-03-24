import './tracing';
import Fastify, { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import cors from '@fastify/cors';

const app = Fastify({ logger: true });
const prisma = new PrismaClient();

// Enable CORS
app.register(cors, {
    origin: ["http://localhost:5173", "https://ticket-blitz.vercel.app"], // Production Vercel domain
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

// Health Check Endpoint (for Render/Railway)
app.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
});

// -- KAFKA CONFIG (Disabled for Quick Demo Mode) --
// import { Kafka } from 'kafkajs';
// const kafka = new Kafka({
//     clientId: 'ticket-blitz-api',
//     brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']
// });
// const producer = kafka.producer();


// -- SIMPLIFIED ASYNC IMPLEMENTATION (Direct DB Write) --
// Quick Demo Mode: Direct database write without Kafka queue
app.post<{ Body: BookingBody }>('/api/book-async', async (request, reply) => {
    const { userId, seatNumber } = request.body;

    try {
        // Find the seat
        const seat = await prisma.seat.findFirst({
            where: { number: seatNumber }
        });

        if (!seat) {
            return reply.status(404).send({ error: "Seat not found" });
        }

        if (seat.status !== "AVAILABLE") {
            return reply.status(409).send({ error: "Seat already taken" });
        }

        const seatId = seat.id;

        // Ensure user exists
        await prisma.user.upsert({
            where: { email: userId },
            update: {},
            create: {
                id: userId,
                email: userId,
                name: "Test User"
            }
        });

        // Book the seat (atomic update)
        await prisma.seat.update({
            where: { id: seatId },
            data: { status: "BOOKED" }
        });

        const booking = await prisma.booking.create({
            data: {
                userId: userId,
                seatId: seatId
            }
        });

        // Return success immediately
        return reply.status(200).send({
            success: true,
            bookingId: booking.id,
            status: "Booked"
        });

    } catch (error) {
        app.log.error(error);
        return reply.status(500).send({ error: "Failed to process booking" });
    }
});

// -- NAIVE IMPLEMENTATION (Vulnerable to Race Conditions) --
// SCENARIO: 2 concurrent requests check status "AVAILABLE" at same time.
// Both pass the 'if' check. Both execute update. Result: Double Booking.

interface BookingBody {
    userId: string;
    seatNumber: number;
}

app.post<{ Body: BookingBody }>('/api/book-naive', async (request, reply) => {
    const { userId, seatNumber } = request.body;

    // 1. READ: Check if seat is available
    // We assume eventId is fixed for this demo (the one we seeded)
    // Ideally we pass eventId, but valid simplification for locking demo.
    const seat = await prisma.seat.findFirst({
        where: { number: seatNumber }
    });

    if (!seat) {
        return reply.status(404).send({ error: "Seat not found" });
    }

    const seatId = seat.id;

    if (seat.status !== "AVAILABLE") {
        // In high concurrency, 100 requests might SKIP this check because
        // they all read the DB state before the first one finished writing.
        return reply.status(409).send({ error: "Seat already taken" });
    }

    // 2. SIMULATE LATENCY (The "Thinking Time")
    // This gap is where the race condition happens.
    await new Promise(r => setTimeout(r, 50));

    // Ensure user exists (Mock Auth)
    // We use the passed userId as both ID and Email for simplicity
    await prisma.user.upsert({
        where: { email: userId },
        update: {},
        create: {
            id: userId,
            email: userId,
            name: "Test User"
        }
    });

    // 3. WRITE: Book the seat
    // We explicitly do NOT use a transaction here to demonstrate the flaw.
    await prisma.seat.update({
        where: { id: seatId },
        data: { status: "BOOKED" }
    });

    const booking = await prisma.booking.create({
        data: {
            userId: userId,
            seatId: seatId
        }
    });

    return { success: true, bookingId: booking.id };
});

// Helper to get a random available seat (for testing)
app.get('/api/random-seat', async (req, reply) => {
    const seat = await prisma.seat.findFirst({
        where: { status: "AVAILABLE" }
    });
    return seat;
});

// -- REDIS CONFIG (Disabled for Quick Demo Mode) --
// import Redis from 'ioredis';
// const redis = new Redis({
//     host: process.env.REDIS_HOST || 'localhost',
//     port: Number(process.env.REDIS_PORT) || 6379
// });
// const subscriber = new Redis({
//     host: process.env.REDIS_HOST || 'localhost',
//     port: Number(process.env.REDIS_PORT) || 6379
// });

// -- SOCKET.IO CONFIG --
import { Server } from 'socket.io';

// Declare the decoration
declare module 'fastify' {
    interface FastifyInstance {
        io: Server;
    }
}

const start = async () => {
    try {
        const port = Number(process.env.PORT) || 3000;

        // Initialize Socket.io (Must be attached to the server instance)
        // We defer listening until after logic setup, but Fastify needs the instance for the hook.
        // Actually, easiest way in this single file is to create io after app.listen or attach to node server.

        await app.ready();
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

// We need to restructure slightly to allow `io` usage in routes.
// A common pattern:
// 1. Create server.
// 2. Create IO.
// 3. Register routes that use IO.

// Let's modify the file structure via the replace tool to:
// 1. Create `io` globally or decorate app.
// 2. Add GET /api/seats
// 3. Update POST /api/book-async

// Re-writing the bottom half:

// -- HELPER: Get all seats --
app.get('/api/seats', async (request, reply) => {
    try {
        const seats = await prisma.seat.findMany({
            orderBy: { id: 'asc' }
        });
        return seats;
    } catch (error) {
        app.log.error(error);
        return reply.status(500).send({ error: "Failed to fetch seats" });
    }
});

// -- SIMPLIFIED ASYNC IMPLEMENTATION (Direct DB Write + Socket Emitting) --
app.post<{ Body: BookingBody }>('/api/book-async', async (request, reply) => {
    const { userId, seatNumber } = request.body;
    try {
        const seat = await prisma.seat.findFirst({ where: { number: seatNumber } });
        if (!seat) return reply.status(404).send({ error: "Seat not found" });
        if (seat.status !== "AVAILABLE") return reply.status(409).send({ error: "Seat already taken" });

        const seatId = seat.id;
        await prisma.user.upsert({
            where: { email: userId },
            update: {},
            create: { id: userId, email: userId, name: "Test User" }
        });

        const updatedSeat = await prisma.seat.update({
            where: { id: seatId },
            data: { status: "BOOKED" }
        });

        await prisma.booking.create({
            data: { userId: userId, seatId: seatId }
        });

        // Emit update to all clients
        if (app.io) {
            app.io.emit('seat-update', { seatNumber: seatNumber, status: 'BOOKED' });
        }

        return reply.status(200).send({ success: true, status: "Booked" });
    } catch (error) {
        app.log.error(error);
        return reply.status(500).send({ error: "Failed to process booking" });
    }
});

// ... (keep Naive implementation if needed, or remove) ...

const main = async () => {
    try {
        const port = Number(process.env.PORT) || 3000;
        const serverAddress = await app.listen({ port, host: '0.0.0.0' });
        console.log(`✅ Server running on ${serverAddress}`);

        const io = new Server(app.server, {
            cors: { origin: "*" }
        });

        // Attach io to app for routes to use
        app.decorate('io', io);
        app.io = io;

        io.on('connection', (socket) => {
            console.log('Client connected', socket.id);
        });

    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

main();
