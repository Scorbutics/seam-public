// Shared logging utility — imported across the whole app (booking handler, service, billing,
// notifications, reporting, admin). High fan-in shared infrastructure: a side-concern the intent
// flows THROUGH, not one it is ABOUT. It bears no crossing, so it is the ubiquity/side-concern
// drop target (must-drop).
export function log(msg: string): void {
  if (process.env.DEBUG) console.log(`[booking-mini] ${msg}`);
}
