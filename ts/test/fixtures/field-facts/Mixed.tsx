import { supabase } from "./db";
// Reads the 'amount' column off the payments row, but ALSO reads an unrelated widget.fee elsewhere.
// A change writing payments.fee must be IRRELEVANT here — the binding must not be fooled by widget.fee.
export function Mixed(widget: { fee: number }) {
  const label = widget.fee;
  return supabase.from("payments").select("amount").then((r) => label + r);
}
