package com.example.field;

// Reads the SAME env key as api/notify.ts. A shared configuration key is a coupling with no code edge:
// change the variable's meaning on one side and the other silently changes behaviour.
public class NotifyWorker {
  public void fire() {
    String url = System.getenv("NOTIFY_WEBHOOK_URL");
    http.post(url, "{}");
  }
}
