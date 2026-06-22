package com.example.orders;

// Backend handler for the orders screen. The framework invokes it by ROUTE — it has no in-repo
// caller, and the only thing that reaches it is the front-end `$http.get("/api/orders")` across the
// HTTP boundary (the shared `/api/orders` literal in the @GetMapping annotation). Without the
// data-coupling overlay this controller looks ISOLATED (a route handler with zero in-repo consumers);
// the overlay is what couples it back to the OrdersPage screen. This is the exact "cross-stack-only
// anchor could look isolated" case the two-tier probe must rescue.
public class OrderController {

  @GetMapping("/api/orders")
  public String listOrders() {
    return "[{\"id\":1,\"total\":42}]";
  }
}
