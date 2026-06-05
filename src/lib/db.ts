import { PrismaClient } from '@prisma/client';

/** Single Prisma instance shared across the process. */
export const prisma = new PrismaClient();
