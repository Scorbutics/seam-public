import { prisma } from "./db";

// A READ of the same table the writes below touch — so one key carries BOTH anchor roles.
export async function loadBooking(id: string) {
  const existing = await prisma.bookings.findFirst({ where: { id } });
  return existing;
}

// THE ANCHOR. Its writes go through a TRANSACTION HANDLE (`tx`), not through the `prisma` client — the exact
// receiver form the real cal.com site uses, and the one a literal `prisma.`-matching renderer would miss.
export async function saveBooking(id: string, startsAt: string) {
  return prisma.$transaction(async (tx: any) => {
    await tx.bookings.update({ where: { id }, data: { startsAt } });
    const booking = await tx.bookings.create({ data: { id, startsAt } });
    return booking;
  });
}
