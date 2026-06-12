// Imports via an UNRESOLVABLE tsconfig alias (~/widget) whose basename matches the anchor
// (`widget`). Can't confirm → SUGGESTED blind spot, never a resolved edge.
import { makeWidget } from "~/widget";

export function aliased() {
  return makeWidget("aliased");
}
