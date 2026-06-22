// The app shell — a screen (nothing in the repo renders it) that mounts OrdersPage. This gives the
// front-end side a real CALL/IMPORT chain (App → OrdersPage → formatOrders), so a probe of OrdersPage
// is non-isolated the cheap way (it reaches a terminal screen and a dep) and never needs the
// data-coupling overlay — unlike the cross-stack OrderController.
import { OrdersPage } from "./OrdersPage";

export function App($http: any) {
  return OrdersPage($http);
}
