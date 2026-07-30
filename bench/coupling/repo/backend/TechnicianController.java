package com.example.field;

// Serves the technician list over HTTP. The React panel reaches it ONLY by the route literal.
public class TechnicianController {
  @GetMapping("/api/technicians")
  public String list() {
    return "[]";
  }
}
