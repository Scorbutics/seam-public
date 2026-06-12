// A CLASS anchor: methods are the carriers; consumers are attributed per-method so the class
// splits by behavioural intent (charge/refund vs validate) instead of lumping.
export class PaymentService {
  charge(amount: number) {
    return { ok: true, amount };
  }
  refund(amount: number) {
    return { ok: true, amount };
  }
  validate(token: string) {
    return token.length > 0;
  }
  unused() {
    return null;   // no consumer → summarised, not an isolated-core warning
  }
}
