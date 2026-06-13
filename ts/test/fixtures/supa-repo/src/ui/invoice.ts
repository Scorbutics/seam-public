// Frontend reader A: shows an invoice by reading the `payments` table.
export function showInvoice(client: any, id: string) {
  return client.from('payments').select('*').eq('id', id);
}
