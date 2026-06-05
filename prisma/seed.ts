import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Demo default is 100 seats (snappy UI). Override for load testing: SEAT_COUNT=5000.
const SEAT_COUNT = Number(process.env.SEAT_COUNT) || 100;

async function main() {
  const existing = await prisma.seat.count();
  if (existing > 0) {
    console.log(`Already seeded (${existing} seats). Skipping.`);
    return;
  }

  const event = await prisma.event.create({
    data: { name: 'The Eras Tour', date: new Date('2026-06-01'), totalSeats: SEAT_COUNT },
  });

  await prisma.seat.createMany({
    data: Array.from({ length: SEAT_COUNT }, (_, i) => ({
      number: i + 1,
      row: 'A',
      status: 'AVAILABLE',
      eventId: event.id,
    })),
  });

  console.log(`Seeded ${SEAT_COUNT} seats for event ${event.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
