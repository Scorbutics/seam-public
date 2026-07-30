package com.example.field;

// Nightly sync: READS the `work_orders` rows the TS API writes. Nothing imports or calls this from the
// TypeScript side and nothing in Java calls it either (a scheduler invokes it) — the only link to
// api/workOrders.ts is the shared table.
public class WorkOrderSync {
  public void sync() {
    jdbc.query("SELECT id, status, technician_id FROM work_orders WHERE status = 'open'");
  }
}
