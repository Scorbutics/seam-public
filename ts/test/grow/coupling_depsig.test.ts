// PER-DELTA COUPLING SIGNATURE (footprint-cache v2, SEAM_FP_DEPSIG) — the coupling half of the granular cache.
// The anchor/fan coupling overlay (cachedCouplingDelta) used to key on the WHOLE-REPO coupling epoch, so any edit
// re-resolved EVERY delta. v2 keys each delta on: its recorded anchor+complement file CONTENT, the route-chain
// structural queries, and a whole-repo coupling-ENVIRONMENT fingerprint (floor⊕http⊕matchers) that captures
// membership/key changes a per-file read-set can't. This pins the contract end-to-end on a floor-coupling grow
// (route-repo: a `payments` writer → route reader → UI), both directions, byte-identical (structural graph equality):
//   1. adding an UNRELATED key-less file → the coupling deltas are REUSED (chit>0, cmiss=0), graph unchanged;
//   2. editing a COMPLEMENT's body (the route handler that reads `payments`) → the delta REBUILDS (its recorded
//      read moved), and the grow still equals a fresh from-scratch grow.
// Hermetic COPIES of the fixture (edits + independent caches); gated on tree-sitter.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { _fpStat, _resetFpStat, _resetFootprintMirror } from "../../src/codebase/scan/footprint_cache.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";
import { resetCallIndex } from "../../src/codebase/scan/up/class_graph.js";
import { _resetImplIndexMem } from "../../src/codebase/scan/down/interface_index.js";
import { resetFileRefIndex } from "../../src/core/resolve/file_ref.js";
import { _resetDefTableMem } from "../../src/codebase/scan/def_table.js";
import { available } from "../../src/codebase/atoms.js";

const FIX = join("test", "fixtures", "route-repo");
const ANCHOR = "backend/persist.ts", SYM = "persistPayment";
const copy = () => { const d = mkdtempSync(join(tmpdir(), "cpl-ds-")); cpSync(FIX, d, { recursive: true }); rmSync(join(d, ".seam"), { recursive: true, force: true }); return d; };
// fresh process: drop in-memory mirrors so a re-grow rehydrates the persisted shards + re-derives against the tree.
const freshRun = () => { _resetFootprintMirror(); resetRepoImports(); resetCallIndex(); _resetImplIndexMem(); resetFileRefIndex(); _resetDefTableMem(); _resetFpStat(); };
const grow = (repo: string) => grow_to_terminals(repo, ANCHOR, SYM, { dataCoupling: true });

// id-independent structural fingerprint of the grown graph (endpoints mapped to file#symbol, sorted).
function ser([data]: [any, any[]]): string {
  const nf = (id: string) => { const n = data.nodes.find((x: any) => x.id === id); return n ? `${n.file}#${n.symbol}` : id; };
  return JSON.stringify({
    nodes: data.nodes.map((n: any) => `${n.file}#${n.symbol}#${(n.range ?? [0])[0]}`).sort(),
    edges: data.edges.map((e: any) => `${nf(e.from)}->${nf(e.to)}:${e.kind}`).sort(),
  });
}

beforeEach(() => { process.env.SEAM_FP_DEPSIG = "1"; delete process.env.SEAM_GRAPH_CACHE; freshRun(); });
afterEach(() => { delete process.env.SEAM_FP_DEPSIG; freshRun(); });

describe("coupling depsig cache — per-delta granular invalidation (byte-identical)", () => {
  test("cold flag-on grow equals a flag-off grow (recording is transparent)", async () => {
    if (!available()) return;
    const rOff = copy(); process.env.SEAM_FP_DEPSIG = ""; const off = ser(await grow(rOff));
    freshRun(); process.env.SEAM_FP_DEPSIG = "1"; const rOn = copy(); const on = ser(await grow(rOn));
    expect(on).toBe(off);
    rmSync(rOff, { recursive: true, force: true }); rmSync(rOn, { recursive: true, force: true });
  });

  test("an UNRELATED key-less file reuses the coupling deltas (chit>0, cmiss=0) and the graph is unchanged", async () => {
    if (!available()) return;
    const R = copy();
    const base = ser(await grow(R));                                  // builds coupling sigs
    freshRun();
    writeFileSync(join(R, "lib", "unrelated_probe.ts"), "export const zzz = 42;\n");   // no keys, not imported
    const out = ser(await grow(R));
    expect(_fpStat().chit).toBeGreaterThan(0);                        // coupling deltas REUSED
    expect(_fpStat().cmiss).toBe(0);                                  // none re-resolved
    expect(out).toBe(base);                                          // graph identical

    // and identical to a fresh from-scratch grow on the same edited tree (no stale hit)
    const Rref = copy(); writeFileSync(join(Rref, "lib", "unrelated_probe.ts"), "export const zzz = 42;\n");
    process.env.SEAM_FP_DEPSIG = ""; freshRun();
    expect(out).toBe(ser(await grow(Rref)));
    rmSync(R, { recursive: true, force: true }); rmSync(Rref, { recursive: true, force: true });
  });

  test("editing a COMPLEMENT's body re-resolves its delta, byte-identical to a fresh grow", async () => {
    if (!available()) return;
    const R = copy();
    await grow(R);                                                    // builds coupling sigs
    freshRun();
    const route = join(R, "app", "api", "admin", "payments", "route.ts");
    appendFileSync(route, "\n// touched the payments route handler body\n");   // complement content moves; key unchanged
    const out = ser(await grow(R));
    expect(_fpStat().cmiss).toBeGreaterThan(0);                       // the delta whose complement changed rebuilt

    const Rref = copy(); appendFileSync(join(Rref, "app", "api", "admin", "payments", "route.ts"), "\n// touched the payments route handler body\n");
    process.env.SEAM_FP_DEPSIG = ""; freshRun();
    expect(out).toBe(ser(await grow(Rref)));                          // rebuilt grow == fresh grow
    rmSync(R, { recursive: true, force: true }); rmSync(Rref, { recursive: true, force: true });
  });
});
