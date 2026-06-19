import { InboundLoadScorer } from "./inboundLoadScorer";
// A SIBLING's own call site: the receiver is provably an InboundLoadScorer, so `score()` here dispatches to
// the sibling's override — NOT a consumer of BusinessCategoryScorer. Must be dropped (not surfaced PARTIAL).
export function checkInbound(): number {
  const s = new InboundLoadScorer();
  return s.score(10);
}
