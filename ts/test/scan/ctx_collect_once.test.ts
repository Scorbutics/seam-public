// Ctx.collect() now serves a WHOLE-TREE collect (root === ctx.root) from a single memoised walk instead of
// re-traversing the tree per call (~6× per file across a grow — the dominant `collect` cost). This pins the
// CORRECTNESS contract of that optimisation, NOT the timing:
//   1. collect(root, pred) is BYTE-IDENTICAL (same nodes, same order) to a naive fresh stack-walk — for the
//      whole-tree case AND the sub-tree case (root !== ctx.root, which still walks live);
//   2. the memoised result is stable across repeated calls (no first-vs-second-call divergence);
//   3. ln(off) (now a binary search over a line-start table) equals the old linear newline count.
// Gated on tree-sitter (the parse) so it early-returns on the offline .vsix / CI.
import { describe, expect, test } from "bun:test";
import { Ctx, makeCtx, available, _CALL, _FUNCLIKE, _NAME_KINDS, _CLASS_KINDS } from "../../src/codebase/atoms.js";

// The PRE-optimisation algorithm, verbatim: a stack-walk that checks pred at pop time. The oracle.
function naiveCollect(ctx: Ctx, root: any, pred: (k: string) => boolean): any[] {
  const out: any[] = []; const st = [root];
  while (st.length) { const x = st.pop(); if (pred(x.type)) out.push(x); for (let i = 0; i < x.childCount; i++) { const c = x.child(i); if (c) st.push(c); } }
  return out;
}
// The pre-optimisation ln(): a linear newline scan. The oracle for the line-start table.
const naiveLn = (content: string, off: number): number => { let c = 0; for (let i = 0; i < off && i < content.length; i++) if (content[i] === "\n") c++; return c; };

const SAMPLES: Record<string, string> = {
  ts: `import { x } from "./m";
export class A extends Base {
  run(a: number) { return helper(a) + this.calc(); }
  calc() { return new B().value; }
}
function helper(n: number) { return n * 2; }
`,
  java: `package p;
class Svc {
  private Repo repo;
  Booking create(Req req) { return repo.save(new Booking(req)); }
}
`,
};

describe("Ctx.collect — collect-once parity with a naive whole-tree walk", () => {
  for (const [lang, src] of Object.entries(SAMPLES)) {
    test(`whole-tree + sub-tree collect is byte-identical to a fresh walk (${lang})`, async () => {
      if (!available()) return;
      const ctx = await makeCtx(src, lang);
      if (!ctx) return;
      for (const pred of [(k: string) => _CALL.has(k), (k: string) => _FUNCLIKE.has(k), (k: string) => _CLASS_KINDS.has(k), (k: string) => _NAME_KINDS.has(k), (k: string) => k.includes("identifier")]) {
        // whole-tree (the memoised fast path)
        const got = ctx.collect(ctx.root, pred);
        const want = naiveCollect(ctx, ctx.root, pred);
        expect(got).toEqual(want);          // same node identities, same order
        expect(ctx.collect(ctx.root, pred)).toEqual(want);   // stable on a second call (memo reuse)
        // sub-tree (live walk, must also match): collect under each top-level child
        for (let i = 0; i < ctx.root.childCount; i++) {
          const sub = ctx.root.child(i); if (!sub) continue;
          expect(ctx.collect(sub, pred)).toEqual(naiveCollect(ctx, sub, pred));
        }
      }
    });

    test(`ln() binary-search equals the linear newline count (${lang})`, async () => {
      if (!available()) return;
      const ctx = await makeCtx(src, lang);
      if (!ctx) return;
      for (let off = 0; off <= src.length; off++) expect(ctx.ln(off)).toBe(naiveLn(src, off));
    });
  }
});
