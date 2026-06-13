import { a } from "./a";
// A consumer of the anchor — the frontier the fallback must climb when the model stalls.
export function b(): number { return a() + 1; }
