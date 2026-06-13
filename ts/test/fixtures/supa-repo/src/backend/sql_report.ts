// A raw-SQL writer (JDBC/libpq-style string query) — NO Supabase builder. The cross-language raw-SQL
// adapter detects the INSERT; it emits the same `db-table` key, so this couples to the Supabase
// readers of `payments` through the shared boundary.
export function archivePayment(db: any, id: string) {
  return db.query("INSERT INTO payments (id, archived) VALUES ($1, true)", [id]);
}
