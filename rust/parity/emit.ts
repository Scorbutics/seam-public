// DIFFERENTIAL: Rust `seam_decompose::emit` vs the TypeScript oracle, over REAL footprint graphs.
//
// emit_seams is the widest surface in this migration: hunk shape, core-grouped ordering, the caller-fan cap,
// the (file,span) dedup, the seam representative, region metadata, the structural-spine lock, seam contracts,
// the blindspot roll-up, the frontier cap. The comparison is over the WHOLE model, JSON-normalised, so any of
// those drifting shows up — and the failure print names the first differing path so it says WHICH.
//
// The corpus is the shared one: fixtures + consumers/dependency footprints over every fixture repo and this
// repo, data coupling both ways. As with the spine harness, tiers/culmination/writes are SYNTHESISED
// deterministically: they are LLM-set, no LLM runs here, and without them the intent-gated branches
// (`region`, `culminationRanked`, the spine lock) are never taken at all.
//
//   bun rust/parity/emit.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { from_resolved_graph, wellformedness, type Graph } from "../../ts/src/core/graph_ir.js";
import { assign_roles } from "../../ts/src/codebase/seams/roles.js";
import { assign_clusters, assign_intent_seams, type Seam } from "../../ts/src/codebase/seams/clusters.js";
import { emit_seams } from "../../ts/src/codebase/seams/emit.js";
import { loadAddon, toResolvedGraph } from "../../ts/src/codebase/rust_core.js";
import { toWire } from "../../ts/src/codebase/seams/wire.js";

const addon = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");
const fixtures = join(REPO, "ts", "test", "fixtures");

const sw = (seams: Seam[]) => JSON.stringify(seams.map((s) => ({
  id: s.id, label: s.label, link_only: s.linkOnly, node_ids: s.node_ids, proposed_by: s.proposedBy,
  ...(s.suggested ? { suggested: true } : {}), ...(s.tier ? { tier: s.tier } : {}),
  ...(s.selected ? { selected: true } : {}),
  ...(s.culmination !== undefined ? { culmination: s.culmination } : {}),
  ...(s.writes ? { writes: s.writes } : {}), ...(s.dir ? { dir: s.dir } : {}),
})));
// health crosses as ROWS, not objects: seam_warnings/node_warnings are JS Maps and an object would lose the
// ordering (and reorder numeric-looking node ids).
const hw = (h: any) => JSON.stringify({
  seam_warnings: [...(h.seam_warnings ?? new Map())].map(([k, v]) => [k, v]),
  node_warnings: [...(h.node_warnings ?? new Map())].map(([k, v]) => [k, v]),
  postures: h.postures ?? {},
});

// ---- corpus ---------------------------------------------------------------------------------------------
const corpus: Array<{ name: string; data: any }> = [];
for (const f of readdirSync(fixtures).filter((f) => f.endsWith("-graph.json"))) {
  corpus.push({ name: f, data: JSON.parse(readFileSync(join(fixtures, f), "utf-8")) });
}
const build = (fn: string, ...args: any[]) => { try { return (addon as any)[fn](...args); } catch { return null; } };
const targets: Array<[string, string, string]> = [];
for (const d of readdirSync(fixtures).filter((d) => d.endsWith("-repo"))) {
  const repo = join(fixtures, d);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name === ".git" || e.name === ".seam" ? [] : walk(join(dir, e.name)))
      : /\.(ts|tsx|js|java|rb|py|go)$/.test(e.name) ? [join(dir, e.name).slice(repo.length + 1)] : []);
  for (const rel of walk(repo).slice(0, 12)) {
    for (const d2 of ((build("defsInFile", rel, readFileSync(join(repo, rel), "utf-8")) ?? []) as any[]).slice(0, 6))
      targets.push([repo, rel, d2.name]);
  }
}
for (const rel of ["ts/src/codebase/seams/emit.ts", "ts/src/codebase/graph.ts", "ts/src/core/graph_ir.ts",
                   "ts/src/codebase/detect.ts"]) {
  if (!existsSync(join(REPO, rel))) continue;
  for (const d of ((build("defsInFile", rel, readFileSync(join(REPO, rel), "utf-8")) ?? []) as any[]).slice(0, 8))
    targets.push([REPO, rel, d.name]);
}
for (const [repo, rel, sym] of targets) {
  for (const fn of ["buildConsumersGraph", "buildDependencyGraph"] as const) {
    for (const dc of [false, true]) {
      const dto = build(fn, repo, rel, sym, null, dc);
      if (!dto) continue;
      let g: any; try { g = toResolvedGraph(dto); } catch { continue; }
      if ((g?.nodes?.length ?? 0) > 1) corpus.push({ name: `${fn}:${dc ? "dc" : "nodc"}:${rel}:${sym}`, data: g });
    }
  }
}

// ---- compare --------------------------------------------------------------------------------------------
let ok = 0, bad = 0, graphs = 0, withHunks = 0, withCallers = 0, fanCapped = 0, withRegion = 0,
    spineLocked = 0, withContracts = 0, withBlindspots = 0, withCulm = 0;
const fails: string[] = [];

// Report the first differing PATH, not the first differing character — on a model this size a raw string
// diff says nothing about which pass drifted.
const firstDiff = (a: any, b: any, path = ""): string | null => {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
    return `${path}: TS=${JSON.stringify(a)} RS=${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length: TS=${a.length} RS=${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    if (!(k in a)) return `${path}.${k}: MISSING in TS (RS=${JSON.stringify(b[k]).slice(0, 120)})`;
    if (!(k in b)) return `${path}.${k}: MISSING in RS (TS=${JSON.stringify(a[k]).slice(0, 120)})`;
    const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d;
  }
  return null;
};

for (const { name, data } of corpus) {
  const mk = () => { const g = from_resolved_graph(JSON.parse(JSON.stringify(data))); assign_roles(g); assign_clusters(g); return g; };
  const g0 = mk();
  if (g0.nodes.size === 0) continue;
  const base = assign_intent_seams(g0);
  if (!base.length) continue;
  graphs++;

  for (const mode of ["plain", "intent", "intent-undirected"] as const) {
    const decorate = (seams: Seam[]) => {
      if (mode === "plain") return seams;
      seams.forEach((s, i) => {
        s.tier = i === 0 ? "spine" : i % 3 === 1 ? "supporting" : "off";
        s.culmination = Math.round((1 / (i + 1)) * 1000) / 1000;
        if (i % 2 === 0) s.writes = [`t${i}`];
        s.dir = i % 2 === 0 ? "forward" : "backward";
      });
      if (seams.length > 1) seams[seams.length - 1].selected = true;
      return seams;
    };
    // The third mode drops `lead`. With a lead the seam adjacency is DIRECTED, so the culmination is often
    // unreachable from the anchor seam and the structural-spine lock never fires — measured at 1 graph in
    // 335. Undirected is the oracle-parity fallback and a real production path (no bidirectional footprint),
    // and it is what actually exercises the lock.
    const opts: any = { intent: mode !== "plain", shape: "flow", ...(mode === "intent" ? { lead: "forward" } : {}) };

    // TS: emit MUTATES the seams it is given (the spine lock), so each side gets its own copy
    const tsSeams = decorate(JSON.parse(JSON.stringify(base)));
    const gTs = mk();
    const tsModel = JSON.parse(JSON.stringify(emit_seams(gTs, wellformedness(gTs), tsSeams, opts)));

    const rsSeams = decorate(JSON.parse(JSON.stringify(base)));
    const gRs = mk();
    const res = JSON.parse(addon.decomposeEmitSeams(
      toWire(gRs), hw(wellformedness(gRs)), sw(rsSeams),
      JSON.stringify({ intent: opts.intent, shape: opts.shape, ...(opts.lead ? { lead: opts.lead } : {}) })));
    const rsModel = res.model;

    const seams0 = tsModel.clusters[0].seams;
    if (seams0.some((s: any) => s.hunks.length)) withHunks++;
    if (seams0.some((s: any) => s.hunks.some((h: any) => h.caller))) withCallers++;
    if (seams0.some((s: any) => s.hunks.some((h: any) => h.summary))) fanCapped++;
    if (seams0.some((s: any) => s.region)) withRegion++;
    if (tsModel.seamContracts.length) withContracts++;
    if (tsModel.blindspots.length) withBlindspots++;
    if (tsModel.clusters[0].culminationRanked) withCulm++;
    // the spine lock must agree about which of the CALLER's seams it rewrote, not just the emitted copies
    const tsLocked = tsSeams.filter((s) => s.tier === "spine").map((s) => s.id).sort();
    const rsLocked0 = rsSeams.filter((s) => s.tier === "spine").map((s) => s.id);
    const rsLocked = [...new Set([...rsLocked0, ...(res.spineLocked ?? [])])].sort();
    if (res.spineLocked?.length) spineLocked++;

    const d = firstDiff(tsModel, rsModel, `${name}[${mode}]`)
           ?? (JSON.stringify(tsLocked) === JSON.stringify(rsLocked) ? null
               : `${name}[${mode}] spineLocked: TS=${JSON.stringify(tsLocked)} RS=${JSON.stringify(rsLocked)}`);
    if (!d) ok++; else { bad++; if (fails.length < 8) fails.push(d); }
  }
}

console.log(`emit parity: ${ok} ok / ${bad} bad   (graphs ${graphs}, with-hunks ${withHunks}, with-callers ${withCallers}, fan-capped ${fanCapped}, with-region ${withRegion}, spine-locked ${spineLocked}, with-contracts ${withContracts}, with-blindspots ${withBlindspots}, with-culmination ${withCulm})`);
for (const x of fails) console.log("  " + x);
if (bad) process.exit(1);
