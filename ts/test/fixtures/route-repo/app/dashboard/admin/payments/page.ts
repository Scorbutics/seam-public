// The admin PAGE (front-end UI). Couples to the `payments` table only through TWO hops: an import of
// `fetchPayments`, then that service's `fetch("/api/admin/payments")` route-fetch crossing.
import { fetchPayments } from "../../../../lib/services.js";
export async function AdminPaymentsPage() {
  const data = await fetchPayments();
  return data;
}
