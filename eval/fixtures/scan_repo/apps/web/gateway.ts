// Implementations of a payment-gateway abstraction — the targets a SUGGESTED crossing finds when
// resolved expansion stops at the interface `IPaymentGateway`.
export class PaymentGateway {
  pay() {
    return true;
  }
}

export class StripePaymentGateway {
  pay() {
    return true;
  }
}
