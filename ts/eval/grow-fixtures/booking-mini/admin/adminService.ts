import { loadBookings } from "../data/bookingRepo.js";
import { log } from "../util/logger.js";

// Admin — another off-intent consumer of the bookings data layer, adding more cross-module fan-in on
// the repo (reinforcing the spine-hub trap).
export async function auditMember(memberId: string) {
  log("audit member");
  return loadBookings(memberId, "");
}
