package com.example.field;

// WRITES `invoices`. The Ruby report below reads them.
public class InvoicePoster {
  public void post(String orderId, int cents) {
    jdbc.update("INSERT INTO invoices (work_order_id, amount_cents, state) VALUES (?, ?, 'due')");
  }
}
