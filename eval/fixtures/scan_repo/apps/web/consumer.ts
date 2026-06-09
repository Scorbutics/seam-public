// Cross-PACKAGE import (@demo/lib → packages/lib) resolving to the anchor.
// Used inside a named function → enclosing symbol = renderPage (function).
import { makeWidget, WIDGET_KIND } from "@demo/lib/widget";

export function renderPage() {
  const w = makeWidget("page");
  return { ...w, kind: WIDGET_KIND };
}
