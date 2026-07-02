import { client } from "../data/db.js";
import { log } from "../util/logger.js";

// Reporting — an off-intent sibling feature that reads the SAME `bookings` table the booking flow
// writes (a grounded db-table crossing, writer=bookingRepo ↔ reader=here). This makes bookingRepo a
// crossing-bearing hub with cross-module consumers: the spine-hub trap. A naive ubiquity gate would
// drop the repo for its fan-in, which I4 forbids because it bears the flow's crossing.
export async function monthlyReport(_memberId: string) {
  log("monthly report");
  return client.from("bookings").select({}).length;
}
