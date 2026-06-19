import { Scorer } from "./scorer";
// Polymorphic dispatch over a base-typed array — the receiver `s` is typed as the bare base, so the call
// could land on ANY subclass (incl. the anchor). Honest ambiguity → must surface as RESOLVED_PARTIAL.
export class Pipeline {
  constructor(private scorers: Scorer[]) {}
  run(ctx: number): number {
    let total = 0;
    for (const s of this.scorers) total += s.score(ctx);
    return total;
  }
}
