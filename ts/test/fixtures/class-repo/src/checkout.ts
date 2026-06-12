import { PaymentService } from "./payment/service";
export function checkout() {
  const svc = new PaymentService(null);
  return svc.charge(100);
}
