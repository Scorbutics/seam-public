import { prisma } from "./db";

// THE FAR SIDE — a counterpart in another file, so the near-side assertions cannot pass merely because the
// key is one-sided.
export async function listBookings() {
  return prisma.bookings.findMany({ orderBy: { startsAt: "asc" } });
}
