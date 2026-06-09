// RELATIVE import that resolves to the anchor (./widget) → a resolved consumer.
import { makeWidget } from "./widget";

export function buildDefault() {
  return makeWidget("default");
}
