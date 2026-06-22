import { supabase } from "../lib/db";
export function Billing() {
  return supabase.from("payments").select("*");
}
