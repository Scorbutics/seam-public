// A writer using a NON-Supabase ORM (Prisma) — the `.from('t').verb()` regex floor can't see this
// write. Only the LLM (discover_keys) recognizes the `payments` table here; it then grounds through
// the SAME shared-key index (which knows the readers via the Supabase floor).
export function prismaPersist(row: any) {
  return prisma.payments.create({ data: { id: row.id, amount: row.amount } });
}
declare const prisma: any;
