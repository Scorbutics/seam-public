// Receiver = `this.<field>` from a constructor-injected `: PaymentService` param (the DI case).
import { PaymentService } from "@demo/lib/payments";

export class Billing {
  constructor(private payments: PaymentService) {}
  run() {
    return this.payments.charge(5);
  }
}
