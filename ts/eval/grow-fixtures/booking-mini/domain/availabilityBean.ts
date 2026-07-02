import { loadBookings } from "../data/bookingRepo.js";
import { mergeIntervals } from "../util/dateRanges.js";

// The mechanism that decides whether a slot is free for a member on a date — the heart of the intent.
// It delegates the core interval computation to a helper (mergeIntervals) whose name shares NO
// vocabulary with "availability" or "booking": the low-cosine-mechanism adversarial case.
export class AvailabilityBean {
  async computeFreeRanges(memberId: string, date: string) {
    const taken = await loadBookings(memberId, date);
    const busy = mergeIntervals(taken.map((b: any) => [b.start, b.end]));
    return this.subtract(dayWindow(date), busy);
  }
  subtract(window: number[][], busy: number[][]) {
    return window.filter((w) => !busy.some((b) => b[0] <= w[0] && b[1] >= w[1]));
  }
}

function dayWindow(_date: string): number[][] { return [[9, 12], [13, 17]]; }
