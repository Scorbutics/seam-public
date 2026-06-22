import { supabase } from "../lib/db";
export function chargeCard(amount) {
  const fee = amount * 0.03;
  return supabase.from("payments").insert({ amount, fee });
}
