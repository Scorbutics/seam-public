// Receiver = `new PaymentService()` binding → charge + refund co-occur (one intent).
import { PaymentService } from "@demo/lib/payments";

export function checkout() {
  const ps = new PaymentService();
  ps.charge(100);
  ps.refund(20);
}
