// Backend WRITER of the `payments` table. Anchored here, the chain must reach the UI in ONE expansion:
// writer → `payments` (db-table) → the route handler that READS it → its http-route → the `fetch` caller.
export function persistPayment(client: any, row: any) {
  return client.from("payments").insert({ id: row.id, amount: row.amount });
}

// A sibling with NO shared key in its own span — the widening case. The file's key lives in `persistPayment`
// above, so a span-scoped scan of this function finds nothing while the MODULE plainly has a boundary. On
// keycloak the same shape is a JAX-RS `@Path` at class level, invisible to every method span in the file.
export function helperNoKeys(row: any) {
  return { ...row, normalised: true };
}
