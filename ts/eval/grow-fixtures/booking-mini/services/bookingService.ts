import { AvailabilityBean } from "../domain/availabilityBean.js";
import { saveBooking } from "../data/bookingRepo.js";
import { charge } from "../billing/billingService.js";
import { notify } from "../notifications/notifier.js";
import { log } from "../util/logger.js";

const availability = new AvailabilityBean();

// The booking flow's core: confirm the slot is free (availability mechanism), persist it (the data
// layer), then bill and notify. The last two are triggered BY the flow but are not what it is about.
export async function bookSlot(memberId: string, date: string) {
  const free = await availability.computeFreeRanges(memberId, date);
  if (!free.length) return { ok: false };
  const booking = await saveBooking(memberId, date);
  await charge(memberId, 42);           // DEPARTURE: billing (peer domain, own DB crossing)
  await notify(memberId, booking.id);   // SIDE-CONCERN: notification
  log(`booked ${booking.id}`);
  return { ok: true, booking };
}
