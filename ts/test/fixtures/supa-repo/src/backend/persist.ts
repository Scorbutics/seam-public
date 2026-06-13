// Backend writer: persists a payment to the `payments` table. No import/call edge reaches the UI that
// later reads it back — only the table name couples them.
export function persistPayment(client: any, row: any) {
  return client
    .from('payments')
    .insert({ id: row.id, amount: row.amount });
}
