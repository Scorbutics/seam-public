// DECOY. Writes and reads `audit_log` entirely within this one file. There is no other side, so a
// counterpart reported here is a false positive — not a discovery.
import { db } from "./client";

export async function writeAudit(msg: string) {
  return db.from("audit_log").insert({ msg });
}

export async function readAudit(id: string) {
  return db.from("audit_log").select("msg").eq("id", id);
}
