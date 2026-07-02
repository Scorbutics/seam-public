import { client } from "../data/db.js";
import { log } from "../util/logger.js";

// Billing — a PEER domain reached from the booking flow via one call (bookSlot → charge). It writes
// its OWN `invoices` table (its own grounded crossing), so a structural gate cannot drop it without
// violating I4; only a semantic border can recognise it departs the booking intent. Must-drop.
export async function charge(memberId: string, amount: number) {
  log(`charge ${memberId} ${amount}`);
  return client.from("invoices").insert({ memberId, amount });
}
