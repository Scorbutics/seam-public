import { PaymentService } from "./payment/service";
export function make(factory: any) {
  const p = factory.get();
  return p.charge(1);
}
