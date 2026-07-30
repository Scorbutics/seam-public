// TS API route: creates and closes work orders. Writes `work_orders`.
import { db } from "../api/client";

export async function createWorkOrder(techId: string, note: string) {
  return db.from("work_orders").insert({ technician_id: techId, note, status: "open" });
}

export async function closeWorkOrder(id: string) {
  return db.from("work_orders").update({ status: "closed" }).eq("id", id);
}
