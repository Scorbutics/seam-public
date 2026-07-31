// A client stub. The floor grounds the syntactic `<recv>.<entity>.<verb>()` shape, not this object.
export const prisma = {
  bookings: {
    findFirst: (_q: any) => null as any,
    update: (_q: any) => null as any,
    create: (_q: any) => null as any,
  },
  $transaction: async (fn: (tx: any) => any) => fn(prisma),
};
