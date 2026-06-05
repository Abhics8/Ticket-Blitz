/**
 * Database-level proof of correctness. Independently of any HTTP response,
 * this asserts that NO seat has more than one booking. Run it after a load
 * test:  npm run verify:oversell
 */
import { prisma } from '../src/lib/db';

async function main() {
  const bookings = await prisma.booking.findMany({ select: { seatId: true } });
  const seatIds = bookings.map((b) => b.seatId);
  const uniqueSeats = new Set(seatIds);
  const oversold = seatIds.length - uniqueSeats.size; // > 0 means a seat was booked twice

  const bookedSeats = await prisma.seat.count({ where: { status: 'BOOKED' } });
  console.log(
    `bookings=${seatIds.length}  uniqueSeatsBooked=${uniqueSeats.size}  bookedSeats=${bookedSeats}  duplicates=${oversold}`
  );

  if (oversold > 0) {
    console.error(`❌ OVERSELL DETECTED — ${oversold} duplicate booking(s) across seats.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log('✅ No oversell: every seat has at most one booking.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
