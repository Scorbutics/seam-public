// Raw-SQL writer of `payments` (no builder) — couples cross-stack/cross-language to the readers below.
export function archivePayment(db: any, id: string) {
  return db.query("INSERT INTO payments (id, archived) VALUES ($1, true)", [id]);
}
