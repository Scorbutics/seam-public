// Frontend reader B: lists payment history (also reads `payments`).
export function paymentHistory(client: any) {
  return client.from('payments').select('id, amount');
}
