// A module WITH a barrel — the entry-point ranking must put this first.
export { placeOrder } from "./placeOrder";
export function orderEntry() {
  return "in";
}
