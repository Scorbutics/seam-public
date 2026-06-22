// A plain front-end helper, imported by OrdersPage — an ordinary in-repo CALL edge. A probe of
// OrdersPage (or of this helper) is connected the cheap way (call/import), so it never needs the
// data-coupling overlay to look non-isolated.
export function formatOrders(data: { id: number; total: number }[]): string[] {
  return data.map((o) => `#${o.id}: ${o.total}`);
}
