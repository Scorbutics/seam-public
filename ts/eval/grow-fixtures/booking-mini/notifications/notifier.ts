import { log } from "../util/logger.js";

// Notifications — a side-concern triggered by the flow (bookSlot → notify) but not part of it. No
// crossing; a clear must-drop side-concern.
export async function notify(memberId: string, bookingId: string) {
  log(`notify ${memberId} ${bookingId}`);
  return { sent: true };
}
