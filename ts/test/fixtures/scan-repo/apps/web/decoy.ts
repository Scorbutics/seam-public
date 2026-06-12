// Imports a same-named `makeWidget` from a DIFFERENT module (./other) that RESOLVES to other.ts,
// NOT the anchor → must be EXCLUDED (a confirmed true-negative, not a blind spot).
import { makeWidget } from "./other";

export function decoy() {
  return makeWidget(1);
}
