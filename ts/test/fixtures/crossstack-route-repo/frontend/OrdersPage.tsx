// Front-end screen: lists the user's orders. It reaches the backend ONLY over an HTTP route
// (`$http.get("/api/orders")`) — there is NO import/call edge to the Java handler. The sole link
// between this screen and the controller is the shared URL `/api/orders` (the cross-stack boundary).
import { formatOrders } from "../lib/format";

export function OrdersPage($http: any) {
  return $http.get("/api/orders").then((res: any) => {
    const rows = formatOrders(res.data);
    return render(rows);
  });
}

function render(rows: string[]): string {
  return rows.join("\n");
}
