// A DEGRADED answer must announce itself even under the quiet filter.
//
// `installQuietFilter` drops every `[tag] ` line so a plain-CLI reader gets only the map. That is right for
// progress chatter and wrong for "your answer is smaller than you asked for": a user who cannot see the
// truncation cannot tell a whole answer from a partial one. This pins the split — progress stays hidden,
// degradation always shows.
import { describe, expect, test } from "bun:test";
import { installQuietFilter, warn, emit } from "../../src/core/progress.js";

describe("the quiet filter hides progress but never a degraded answer", () => {
  test("warn() survives installQuietFilter; emit() and plain [tag] lines do not", () => {
    const orig = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    (process.stderr as any).write = (s: any) => { seen.push(String(s)); return true; };
    try {
      installQuietFilter();
      emit("a progress step");                                   // chatter → dropped
      process.stderr.write("[grow] src/x.ts key epoch=e HIT\n");  // diagnostic → dropped
      warn("[centers] node budget 4 reached — skipping remaining mechanism(s)");   // degradation → KEPT
    } finally { (process.stderr as any).write = orig; }
    const joined = seen.join("");
    expect(joined).toContain("node budget 4 reached");   // the truncation is visible
    expect(joined).not.toContain("a progress step");     // the chatter is not
    expect(joined).not.toContain("[grow] src/x.ts");
  });
});
