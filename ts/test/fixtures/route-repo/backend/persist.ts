// Backend WRITER of the `payments` table. Anchored here, the chain must reach the UI in ONE expansion:
// writer → `payments` (db-table) → the route handler that READS it → its http-route → the `fetch` caller.
export function persistPayment(client: any, row: any) {
  return client.from("payments").insert({ id: row.id, amount: row.amount });
}
