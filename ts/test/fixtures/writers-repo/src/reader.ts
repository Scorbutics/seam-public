import { supabase } from "./db";

// READS the bookings table — the anchor for `--query writers`.
export function listBookings(memberId: string) {
  const { data } = supabase.from('bookings').select('id, member_id, starts_at');
  return data.filter((b: any) => b.member_id === memberId);
}
