import { supabase } from "../lib/db";
export function Audit() {
  return supabase.from("payments").select("amount");
}
