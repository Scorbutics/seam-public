// Receiver = a `: PaymentService`-typed parameter → validate (a different intent).
import { PaymentService } from "@demo/lib/payments";

export function adminCheck(ps: PaymentService, token: string) {
  return ps.validate(token);
}
