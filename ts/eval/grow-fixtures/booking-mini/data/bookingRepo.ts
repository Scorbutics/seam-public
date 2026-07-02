import { client } from "./db.js";

// The data layer for bookings — the flow's grounded DB crossing (the `bookings` table). It is ALSO
// consumed by reporting and admin (see reportService / adminService), giving it a high consumer
// fan-in: the spine-hub adversarial case. Despite the fan, it bears the flow's crossing, so no
// deterministic ubiquity/hub gate may drop it (invariant I4).
export async function loadBookings(memberId: string, date: string) {
  return client.from("bookings").select({ memberId, date });
}

export async function saveBooking(memberId: string, date: string) {
  return client.from("bookings").insert({ memberId, date, id: rid() });
}

function rid(): string { return "bk_" + memberSeq++; }
let memberSeq = 0;
