// DIFFERENTIAL: Rust `seam_decompose::spine` vs the TypeScript oracle, over REAL footprint graphs.
//
// Nine passes compared independently so a failure names the one that drifted: spine_order, seam_path,
// extract_paths, structural_spine, promote_spine_path, collapse_off_seams, promote_terminals, detect_shape,
// lead_slice.
//
// The corpus reuses the decompose one (fixtures + footprints grown over every fixture repo and this repo,
// data coupling both ways), then runs the REAL floor to get seams — so the seams fed in are the ones the
// engine actually produces, not hand-built shapes.
//
// TIERS ARE SYNTHESISED. Every spine function keys off `tier`/`selected`, which only an LLM pass sets, and
// no LLM runs here. Comparing untiered seams would leave spine_order returning [] on both sides and
// promote_spine_path with nothing to promote — green, and worth nothing. So each graph is run twice: once
// untiered (the skeleton path, which is a real production path) and once with a DETERMINISTIC synthetic
// tiering, so the tier-dependent branches are actually taken. The counters below report both.
//
//   bun rust/parity/spine.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { from_resolved_graph, type Graph } from "../../ts/src/core/graph_ir.js";
import { assign_roles } from "../../ts/src/codebase/seams/roles.js";
import { assign_clusters, assign_intent_seams, type Seam } from "../../ts/src/codebase/seams/clusters.js";
import {
  _spine_order, _seam_path, extract_paths, _structural_spine, _promote_spine_path,
  collapse_off_seams, _promote_terminals, _detect_shape, _lead_slice,
} from "../../ts/src/codebase/seams/spine.js";
import { loadAddon, toResolvedGraph } from "../../ts/src/codebase/rust_core.js";
// THE PRODUCTION WIRE, imported rather than re-declared. This harness used to carry its own copy, and
// that copy included `direction` while the real one did not — so the harness was green while every
// bidirectional footprint reached the core with its directions stripped. A harness must exercise the
// encoding the engine actually uses, or it is testing a different program.
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
})));

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
for (const rel of ["ts/src/codebase/seams/spine.ts", "ts/src/codebase/graph.ts", "ts/src/core/graph_ir.ts",
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
let ok = 0, bad = 0, graphs = 0, tiered = 0, withPaths = 0, withSpine = 0, promoted = 0, collapsed = 0, policies = 0;
const fails: string[] = [];
const norm = (x: any) => JSON.stringify(x);
const check = (name: string, pass: string, tsv: any, rsv: any) => {
  if (norm(tsv) === norm(rsv)) { ok++; return; }
  bad++;
  if (fails.length < 6) fails.push(`${pass} ${name}\n  TS: ${norm(tsv).slice(0, 400)}\n  RS: ${norm(rsv).slice(0, 400)}`);
};

for (const { name, data } of corpus) {
  const mk = () => { const g = from_resolved_graph(JSON.parse(JSON.stringify(data))); assign_roles(g); assign_clusters(g); return g; };
  const g0 = mk();
  if (g0.nodes.size === 0) continue;
  graphs++;

  // --- promote_terminals + detect_shape read the graph alone
  const gt = mk(); _promote_terminals(gt);
  check(name, "promote_terminals", gt.anchors, addon.decomposePromoteTerminals(toWire(mk())));
  const shape = _detect_shape(g0);
  if (shape === "policy") policies++;
  check(name, "detect_shape", shape, addon.decomposeDetectShape(toWire(g0)));

  // DIRECTIONS ARE SYNTHESISED, for the same reason the tiers are. `direction` is only set on bidirectional
  // footprints, and the corpus is built from the consumers/dependency builders — so without this every
  // detect_shape comparison answers "flow" on both sides and the POLICY branch (the wide subjectless
  // import-only fan) is never taken at all. Assigned deterministically by node index.
  const gd = mk();
  [...gd.nodes.values()].forEach((n, i) => { (n as any).direction = i % 4 === 0 ? "backward" : "forward"; });
  const dShape = _detect_shape(gd);
  if (dShape === "policy") policies++;
  check(`${name}[directed]`, "detect_shape", dShape, addon.decomposeDetectShape(toWire(gd)));

  const base = assign_intent_seams(g0);
  if (!base.length) continue;

  // UNTIERED (the skeleton path) then a deterministic synthetic tiering, so the tier-gated branches run
  for (const mode of ["untiered", "tiered"] as const) {
    const seams: Seam[] = JSON.parse(JSON.stringify(base));
    if (mode === "tiered") {
      seams.forEach((s, i) => { s.tier = i === 0 ? "spine" : i % 3 === 1 ? "supporting" : "off"; });
      if (seams.length > 1) seams[seams.length - 1].selected = true;
      tiered++;
    }
    const tag = `${name}[${mode}]`;
    const gw = toWire(g0), sj = sw(seams);

    const tsOrder = _spine_order(g0, seams);
    if (tsOrder.length) withSpine++;
    check(tag, "spine_order", tsOrder, addon.decomposeSpineOrder(gw, sj, undefined));

    const tsPaths = extract_paths(g0, seams);
    if (tsPaths.length) withPaths++;
    check(tag, "extract_paths", tsPaths, JSON.parse(addon.decomposeExtractPaths(gw, sj, undefined)));

    check(tag, "structural_spine", _structural_spine(g0, seams), addon.decomposeStructuralSpine(gw, sj, undefined));

    const a = seams[0].id, b = seams[seams.length - 1].id;
    check(tag, "seam_path", _seam_path(g0, seams, a, b), addon.decomposeSeamPath(gw, sj, a, b));

    const promSeams: Seam[] = JSON.parse(JSON.stringify(seams));
    _promote_spine_path(g0, promSeams, a, b);
    const tsProm = promSeams.filter((s, i) => s.tier !== seams[i].tier).map((s) => s.id);
    if (tsProm.length) promoted++;
    check(tag, "promote_spine_path", tsProm, addon.decomposePromoteSpinePath(gw, sj, a, b));

    for (const cap of [2, 8]) {
      const tsC = collapse_off_seams(JSON.parse(JSON.stringify(seams)), cap).map((s) => [s.id, s.label, s.node_ids, s.tier ?? null]);
      if (tsC.some((r: any) => r[0] === "off-more")) collapsed++;
      const rsC = (JSON.parse(addon.decomposeCollapseOffSeams(sj, cap)) as any[]).map((s) => [s.id, s.label, s.node_ids, s.tier ?? null]);
      check(`${tag} cap=${cap}`, "collapse_off", tsC, rsC);
    }

    check(tag, "lead_slice", _lead_slice(g0, seams, shape), addon.decomposeLeadSlice(gw, sj, shape));
    // on the DIRECTED copy the answer-seam's forward/backward tally is non-trivial, so the branch that
    // follows the LLM's pick (rather than the shape default) is actually exercised
    for (const sh of ["policy", "flow"]) {
      check(`${tag}[directed ${sh}]`, "lead_slice", _lead_slice(gd, seams, sh as any),
            addon.decomposeLeadSlice(toWire(gd), sj, sh));
    }
  }
}

console.log(`spine parity: ${ok} ok / ${bad} bad   (graphs ${graphs}, tiered-runs ${tiered}, with-spine ${withSpine}, with-paths ${withPaths}, promotions ${promoted}, collapses ${collapsed}, policies ${policies})`);
for (const x of fails) console.log(x);
if (bad) process.exit(1);
