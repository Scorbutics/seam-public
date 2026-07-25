// REGRESSION — a method passed as a BOUND REFERENCE (`this._impl.bind(this)`) into a batching/wrapper helper must
// still yield a GROUNDED call edge to the real implementation, so the grow reaches it.
//
// Measured on cal.com before the fix: growing from
// `packages/trpc/server/routers/viewer/slots/util.ts#_getAvailableSlots` NEVER reached
// `_getBusyTimesFromLimitsForUsers` (util.ts:393) or `_getBusyTimesFromTeamLimitsForUsers` (util.ts:622) — the
// batched implementations the slots path actually runs. The down footprint emitted ZERO same-file edges at all.
// Two independent gaps, both pinned here:
//   1. `_intraFileCalleePass` finds callees via `_call_lines`, which only matches a call node whose callee is a
//      BARE identifier — so every `this.m(...)` sibling call was invisible.
//   2. The wrapper member is a class FIELD (`m = withReporting(this._impl.bind(this), …)`), not a
//      `method_definition`, so it is not a named unit, AND the bound reference is never CALLED at that site — it
//      is passed as an ARGUMENT. Nothing in the scan read a member REFERENCE, only calls.
//
// The fix reads self-member REFERENCES (`this.m()`, `f(this.m)`, `f(this.m.bind(this))`) and resolves each
// against the ENCLOSING class's own declarations, span-scoped inside the class node, with ONE alias hop through a
// function-valued field. That grounding is what keeps it free of false positives, which the negative cases pin:
// a same-name method on an unrelated class — in another file OR in the same file — must NOT be linked.
//
// Hermetic (tmp git repo built in beforeAll, removed in afterAll), expectations derived from the fixture, guarded
// on tree-sitter (`available()`) so the suite stays green offline / in the .vsix.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { available } from "../../src/codebase/atoms.js";
import { build_footprint } from "../../src/codebase/scan/index.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";

const SRC: Record<string, string> = {
  // the cal.com `withReporting` shape: an identity-ish HOF the real method is BOUND through.
  "src/batching.ts": [
    `export function withBatching<T>(fn: T, _name: string): T {`,
    `  return fn;`,
    `}`,
    ``,
  ].join("\n"),
  // the DEEP callee behind the bound reference — reaching this is the whole point.
  "src/limits.ts": [
    `export async function loadLimitBusyTimes(userId: number) {`,
    `  return [{ userId }];`,
    `}`,
    ``,
  ].join("\n"),
  // the DECOY deep callee — only reachable through a SAME-NAMED method on an unrelated class. Reaching it would
  // mean the resolution fell back to a repo-wide name match.
  "src/decoy_deep.ts": [
    `export function decoyDeepCallee(n: number) {`,
    `  return n * 2;`,
    `}`,
    ``,
  ].join("\n"),
  // NEGATIVE #1 — an unrelated class in ANOTHER file declaring a method of the SAME name.
  "src/unrelated.ts": [
    `import { decoyDeepCallee } from "./decoy_deep";`,
    ``,
    `export class UnrelatedService {`,
    `  async _limitsImpl(n: number) {`,
    `    return decoyDeepCallee(n);`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
};
// the ANCHOR file. `orchestrate` reaches `_limitsImpl` ONLY through the bound-reference wrapper field, and
// `_oooImpl` ONLY through a BARE `this.m` callback — the same phenomenon without `.bind`.
// NEGATIVE #2: `InFileDecoy` (same file) declares a method of the SAME name, calling a different deep callee.
SRC["src/slots.ts"] = [
  `import { withBatching } from "./batching";`,
  `import { loadLimitBusyTimes } from "./limits";`,
  ``,
  `function decoySiblingCallee(n: number) {`,
  `  return n + 1;`,
  `}`,
  ``,
  `export class InFileDecoy {`,
  `  async _limitsImpl(n: number) {`,
  `    return decoySiblingCallee(n);`,
  `  }`,
  `}`,
  ``,
  `export class SlotsService {`,
  `  async orchestrate(userId: number) {`,
  `    const limits = await this.batchedLimits(userId);`,
  `    const ooo = await this.runCallback(this._oooImpl);`,
  `    return { limits, ooo };`,
  `  }`,
  ``,
  `  private async _limitsImpl(userId: number) {`,
  `    return loadLimitBusyTimes(userId);`,
  `  }`,
  ``,
  `  private batchedLimits = withBatching(this._limitsImpl.bind(this), "batchedLimits");`,
  ``,
  `  private async _oooImpl() {`,
  `    return [];`,
  `  }`,
  ``,
  `  private async runCallback(fn: () => Promise<unknown[]>) {`,
  `    return fn();`,
  `  }`,
  `}`,
  ``,
].join("\n");

// Expectations DERIVED from the fixture, never hard-coded: the 0-based declaration line of each method, and the
// line of the `this.batchedLimits(...)` call the edge should cite.
const lineOf = (rel: string, needle: string): number => SRC[rel].split("\n").findIndex((l) => l.includes(needle));
const SLOTS_IMPL_LINE = lineOf("src/slots.ts", "private async _limitsImpl(");
const DECOY_IMPL_LINE = lineOf("src/slots.ts", "  async _limitsImpl(");
const CALL_LINE = lineOf("src/slots.ts", "await this.batchedLimits(");

let REPO = "";
beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-bound-self-"));
  for (const [rel, text] of Object.entries(SRC)) {
    const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
  }
  writeFileSync(join(REPO, "package.json"), `{ "name": "bound-self", "version": "1.0.0" }\n`);
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

const down = () => build_footprint(REPO, "src/slots.ts", "orchestrate", { direction: "down", dataCoupling: false } as any);

describe("scan/down — a bound sibling-method reference resolves to the real implementation", () => {
  test("the fixture really is the bound-reference shape (non-vacuous)", () => {
    expect(SLOTS_IMPL_LINE).toBeGreaterThan(0);
    expect(DECOY_IMPL_LINE).toBeGreaterThan(0);
    expect(DECOY_IMPL_LINE).toBeLessThan(SLOTS_IMPL_LINE);        // the DECOY is declared FIRST — a name lookup would find it
    expect(CALL_LINE).toBeGreaterThan(0);
    expect(SRC["src/slots.ts"]).toContain("this._limitsImpl.bind(this)");   // passed as an ARGUMENT, never called there
  });

  test("`withBatching(this._impl.bind(this))` yields a grounded call edge to the real method", async () => {
    if (!available()) return;
    const g: any = await down();
    const impl = (g.nodes as any[]).find((n) => n.symbol === "_limitsImpl");
    expect(impl).toBeDefined();
    expect(impl.file).toBe("src/slots.ts");
    // the SPAN proves WHICH `_limitsImpl` was bound: the anchor's own class, not the same-file decoy declared above it.
    expect(impl.range[0]).toBe(SLOTS_IMPL_LINE);
    const edge = (g.edges as any[]).find((e) => e.from === "n1" && e.to === impl.id);
    expect(edge).toBeDefined();
    expect(edge.kind).toBe("call");
    expect(edge.provenance).toBe("RESOLVED_FULL");
    expect(edge.line).toBe(CALL_LINE);          // cited at the `this.batchedLimits(...)` site
  });

  test("a BARE `this.m` passed as a callback resolves too (the same phenomenon without .bind)", async () => {
    if (!available()) return;
    const g: any = await down();
    expect((g.nodes as any[]).some((n) => n.symbol === "_oooImpl" && n.file === "src/slots.ts")).toBe(true);
  });

  test("NEGATIVE — a same-name method on an unrelated class is never linked", async () => {
    if (!available()) return;
    const g: any = await down();
    const files = (g.nodes as any[]).map((n) => String(n.file ?? ""));
    expect(files).not.toContain("src/unrelated.ts");      // another file's UnrelatedService._limitsImpl
    expect(files).not.toContain("src/decoy_deep.ts");     // ...nor anything only IT reaches
    // the same-FILE collision: only ONE `_limitsImpl` node exists and it is the anchor's class's (span asserted above)
    expect((g.nodes as any[]).filter((n) => n.symbol === "_limitsImpl").length).toBe(1);
  });

  test("the grow reaches the deep callee BEHIND the bound reference, and never the decoys", async () => {
    if (!available()) return;
    const grown: any = await grow_to_terminals(REPO, "src/slots.ts", "orchestrate",
      { maxSteps: 8, maxNodes: 60, dataCoupling: false, structuralGrow: true } as any);
    const data = Array.isArray(grown) ? grown[0] : grown;
    const files = (data.nodes as any[]).map((n) => String(n.file ?? ""));
    // the deep callee must be reached THROUGH `_limitsImpl` — presence alone is not enough (the anchor file also
    // imports it, so a node would exist even with no edge from the implementation).
    const impl = (data.nodes as any[]).find((n) => n.symbol === "_limitsImpl" && n.range?.[0] === SLOTS_IMPL_LINE);
    expect(impl).toBeDefined();
    const deep = (data.nodes as any[]).filter((n) => n.symbol === "loadLimitBusyTimes").map((n) => n.id);
    expect(deep.length).toBeGreaterThan(0);
    expect((data.edges as any[]).some((e) => e.from === impl.id && deep.includes(e.to))).toBe(true);
    expect(files.some((f) => f.endsWith("src/decoy_deep.ts"))).toBe(false);
    // (the same-FILE decoy is pinned on the DOWN footprint above — by span + node count — because the grow is
    // bidirectional: `InFileDecoy` legitimately shows up BACKWARD as a consumer of the anchor file's own defs.)
  });
});
