import { bookSlot } from "../services/bookingService.js";
import { log } from "../util/logger.js";

// HTTP handler (the grow anchor): a member requests to book a slot on a date. Delegates the whole
// booking mechanism to the service. This is the entry point the intent starts from.
export async function createBooking(memberId: string, date: string) {
  log(`createBooking member=${memberId}`);
  return bookSlot(memberId, date);
}
