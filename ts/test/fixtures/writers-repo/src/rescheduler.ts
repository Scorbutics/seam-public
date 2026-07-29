import { supabase } from "./db";

// A SECOND writer (update, not create) of the same table — so the answer is a SET, not a single site, and
// the create/update distinction is visible.
export function reschedule(id: string, startsAt: string) {
  return supabase.from('bookings').update({ starts_at: startsAt });
}
