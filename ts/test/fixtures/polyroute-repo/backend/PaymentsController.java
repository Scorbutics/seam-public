// Spring backend route HANDLER. NO framework adapter recognises this — the path lives in a `@GetMapping`
// annotation the deterministic floor doesn't parse. The LLM (discover_keys) reads it and names the route;
// it grounds against the JS `fetch` caller the http-route adapter already indexed. NO Java adapter needed.
package com.acme.admin;

@RestController
public class PaymentsController {
  @GetMapping("/api/admin/payments")
  public List<Payment> getPayments() {
    return repo.findAll();
  }
}
