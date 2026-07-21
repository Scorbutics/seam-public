// The call-site pass recomputes per-candidate AST analysis (`_method_call_sites`/`_instance_types`/`_type_names`)
// once per candidate consumer PER up-move; candidates overlap heavily across moves, and the parse (makeCtx) is
// cached so the same Ctx recurs — yet the analysis was recomputed every time (measured ~67s / 6195 calls of a
// cold cal.com grow; the whole wave). These are now memoised per Ctx. `_method_call_sites` in particular shares a
// per-Ctx ALL-sites walk and filters by the requested methods, so the sharp edge is: a second call with a
// DIFFERENT method set must return THAT set's sites, not the first call's. This pins that (and the pure per-Ctx
// memo consistency). Hermetic tmp git repo; tree-sitter-gated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx, available } from "../../src/codebase/atoms.js";
import { _method_call_sites, _instance_types, _type_names } from "../../src/codebase/scan/ast_class.js";

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "seam-csmemo-"));
  mkdirSync(repo, { recursive: true });
  try { execSync("git init -q", { cwd: repo, stdio: "ignore" }); } catch { /* git optional */ }
});
afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("call-site analysis memo — per-Ctx, filtered per method set", () => {
  test("shared all-sites cache filters by the REQUESTED methods (not the first call's)", async () => {
    if (!(await available())) return;   // tree-sitter absent → degrade
    const src = `class C { alpha() {} beta() {} }\nfunction use(c) { c.alpha(); c.alpha(); c.beta(); }\n`;
    const ctx = (await makeCtx(src, "typescript"))!;
    if (!ctx) return;

    const alpha = _method_call_sites(ctx, new Set(["alpha"]));
    const beta = _method_call_sites(ctx, new Set(["beta"]));     // 2nd call, DIFFERENT method set — must NOT return alpha's sites
    const both = _method_call_sites(ctx, new Set(["alpha", "beta"]));
    const none = _method_call_sites(ctx, new Set(["gamma"]));

    expect(alpha.map((s) => s.method)).toEqual(["alpha", "alpha"]);   // only alpha's two sites
    expect(beta.map((s) => s.method)).toEqual(["beta"]);              // only beta's one site (not stale alpha)
    expect(both.length).toBe(3);                                      // union across a shared cache
    expect(none.length).toBe(0);                                      // a method with no call site
    // idempotent: the memoised walk returns a stable result on repeat
    expect(_method_call_sites(ctx, new Set(["alpha"]))).toEqual(alpha);
  });

  test("pure per-Ctx memos (_instance_types / _type_names) are consistent across calls", async () => {
    if (!(await available())) return;
    const src = `class Engine {}\nfunction f() { const e: Engine = new Engine(); return e; }\n`;
    const ctx = (await makeCtx(src, "typescript"))!;
    if (!ctx) return;
    expect(_type_names(ctx)).toEqual(_type_names(ctx));           // memoised → stable
    expect([..._type_names(ctx)]).toContain("Engine");
    const it1 = _instance_types(ctx), it2 = _instance_types(ctx);
    expect([...it1.keys()]).toEqual([...it2.keys()]);
  });
});
