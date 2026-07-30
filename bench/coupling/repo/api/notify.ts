// Reads the shared webhook config. The Java worker below reads the SAME env key — no import links them.
export function notifyUrl(): string {
  return process.env.NOTIFY_WEBHOOK_URL ?? "";
}
