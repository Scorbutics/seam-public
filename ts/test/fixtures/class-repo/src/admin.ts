import { PaymentService } from "./payment/service";
export function admin(s: PaymentService) {
  s.charge(50);
  s.refund("x1");
}
