// TS Supabase reader of `payments`.
export function showInvoice(client: any, id: string) {
  return client.from('payments').select('*').eq('id', id);
}
