// JS front-end service (route CONSUMER) — the `fetch` path literal is indexed by the http-route adapter,
// so it grounds the LLM-proposed Java route key with no extra machinery.
export async function fetchPayments() {
  const res = await fetch("/api/admin/payments", { credentials: "include" });
  return res.json();
}
