import { b } from "./b";
// A consumer-of-a-consumer — only reachable by climbing the frontier a SECOND hop.
export function c(): number { return b() + 1; }
