import { supabase } from "./db";

// WRITES the bookings table (create) — a counterpart the reader must be told about.
export function createBooking(memberId: string, startsAt: string) {
  return supabase.from('bookings').insert({ member_id: memberId, starts_at: startsAt });
}
