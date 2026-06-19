import { Scorer } from "./scorer";
// A SIBLING scorer (same base) with its own `score` override.
export class InboundLoadScorer extends Scorer {
  score(ctx: number): number { return ctx + 1; }
}
