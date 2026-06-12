// Imports the class but never calls a method on a traced instance (used as a value) → honest
// "untraced-instance" blind spot, NOT a wrong attribution.
import { PaymentService } from "@demo/lib/payments";

export const services = [PaymentService];
