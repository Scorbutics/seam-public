export class PaymentService {
  constructor(private db: any) {}
  charge(amount: number) { return amount; }
  refund(id: string) { return id; }
  audit() { return true; }
}
