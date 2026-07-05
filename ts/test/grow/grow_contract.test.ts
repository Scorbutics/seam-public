// BEHAVIOUR PIN for the grow (see docs/grow-architecture.md). Snapshots the FULL footprint — nodes
// (symbol|file|kind|coupling|direction) and edges (by symbol) — produced by grow_to_terminals on fixtures,
// and asserts it stays byte-identical. This is the contract the phase extraction (Step 1) must preserve: a
// "refactor" that silently changed coupling scope is exactly what this catches. Run WITHOUT intent so the
// footprint is deterministic (no embedding wobble). To intentionally change grow behaviour, regenerate the
// oracle in the SAME commit and review the diff on purpose. Guards on tree-sitter (offline .vsix / CI).
//
// NOTE: the oracle pins CURRENT behaviour, warts included — e.g. a coupling complement mislabelled `String`
// (a return-type-as-name bug in complement_unit, a P3 concern). Pinning it makes the bug localisable; fixing
// it is a deliberate P3 change that regenerates this oracle.
import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync, cpSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fx = (rel: string) => join(__dir, "..", "fixtures", rel);
const oracle = JSON.parse(readFileSync(join(__dir, "..", "oracle", "grow_contract.json"), "utf-8"));

const snap = (data: any) => ({
  nodes: data.nodes.map((n: any) => `${n.symbol}|${n.file}|${n.kind}${n.coupling ? "|C" : ""}${n.direction ? "|" + n.direction : ""}`).sort(),
  edges: data.edges.map((e: any) => { const f = data.nodes.find((n: any) => n.id === e.from), t = data.nodes.find((n: any) => n.id === e.to); return `${f?.symbol ?? e.from}->${t?.symbol ?? e.to}:${e.kind}`; }).sort(),
});

// The footprint/grow caches (`footprint_cache.ts._mem`) are process-global, keyed by REPO PATH. Under bun's
// concurrent test files a grow of the SAME fixture in another file could share those cache entries and shift the
// edge set. So COPY each fixture to a UNIQUE tmp repo per case (its own private cache namespace) — hermetic,
// order-independent, deterministic. `.seam` is excluded from the copy so no stale cache leaks in.
const tmpRoot = mkdtempSync(join(tmpdir(), "seam-growcontract-"));
const copyRepo = (rel: string, tag: string): string => {
  const dst = join(tmpRoot, `${tag}-${rel.replace(/[\\/]/g, "_")}`);
  cpSync(fx(rel), dst, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes(".seam") });
  return dst;
};
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const CASES = [
  { repo: "crossstack-route-repo", file: "frontend/OrdersPage.tsx", sym: "OrdersPage", opts: { maxSteps: 6, maxNodes: 40, dataCoupling: true } },
  { repo: "crossstack-route-repo", file: "backend/OrderController.java", sym: "OrderController", opts: { maxSteps: 6, maxNodes: 40, bidirectional: true, dataCoupling: true } },
  { repo: "route-repo", file: "app/api/admin/payments/route.ts", sym: "GET", opts: { maxSteps: 6, maxNodes: 40, dataCoupling: true } },
];

describe("grow contract — footprint is pinned (Step 0)", () => {
  CASES.forEach((c, i) => {
    const key = `${c.file}:${c.sym}`;
    test(`footprint stable: ${key}`, async () => {
      if (!available()) return;
      const repo = copyRepo(c.repo, `c${i}`);   // a private copy → private cache namespace
      const [data] = await grow_to_terminals(repo, c.file, c.sym, c.opts as any);
      expect(snap(data)).toEqual(oracle[key]);
    });
  });
});
