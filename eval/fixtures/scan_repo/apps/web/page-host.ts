// DEPTH-2: this imports an exported depth-1 consumer (renderPage), not the anchor itself. It is the
// environment ripple / boundary frontier — a consumer-of-a-consumer.
import { renderPage } from "./consumer";

export function host() {
  return renderPage();
}
