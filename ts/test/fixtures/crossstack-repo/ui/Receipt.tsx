import { supabase } from "../lib/db";
export function Receipt() {
  return supabase.from("payments").select("fee");
}
