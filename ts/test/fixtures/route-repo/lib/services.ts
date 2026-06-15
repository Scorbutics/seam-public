// Service layer (route CONSUMER): the only place that names the URL. The admin page reaches the route
// THROUGH this module — an import hop from the page, then a route-fetch crossing to the handler.
export async function fetchPayments() {
  const res = await fetch("/api/admin/payments", { credentials: "include" });
  return res.json();
}
export async function fetchPaymentDetail(id: string) {
  const res = await fetch(`/api/admin/payments/${id}`, { credentials: "include" });
  return res.json();
}
