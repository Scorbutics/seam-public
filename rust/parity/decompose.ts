// Rust `seam_decompose` vs the TypeScript passes, over REAL footprint graphs.
//
// THIS IS NOW A SMOKE TEST, NOT AN ORACLE. Its differential value was spent BEFORE the deletion: it ran
// against the real TypeScript implementations and agreed on 1364/1364 comparisons over 341 graphs, which is
// what licensed removing them. `ts/src/codebase/seams/{roles,clusters}.ts` are thin wrappers over the core
// now, so both sides of this comparison are the same Rust — it exercises the wire (the node-array encoding,
// the seam field-name mapping, the env sync) end to end and will catch a marshalling regression, but it can
// no longer catch an algorithm one.
//
// It was also falsified before being trusted: perturbing the hub fraction turned it red on 3 graphs. A
// harness nobody has ever seen fail is not evidence.
//
// Four passes, compared independently so a failure names which one drifted:
//   assign_roles            per-node role + confidence
//   assign_clusters         per-node group id + intent label
//   assign_intent_seams     the HUB-aware carrier split (and its two fallbacks)
//   extract_suggested_seams the crossing split + the `suggested` marking
//
// The corpus is built, not fixed: every *-graph.json fixture, plus consumers/dependency/class footprints
// grown over each *-repo fixture AND over the seam repo itself. That matters — a hand-written graph exercises
// the shape you thought of, and the ordering hazards in this port (group ids numbered by walk order, `maxBy`
// keeping the first of equal complexities, hub bars that depend on consumer counts) only bite at real fan-out.
//
// READ THE NON-EMPTY COUNTER, not just `0 bad`. A harness comparing empty against empty is green and proves
// nothing; that has already happened twice in this migration.
//
//   bun rust/parity/decompose.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { from_resolved_graph, type Graph } from "../../ts/src/core/graph_ir.js";
import { assign_roles } from "../../ts/src/codebase/seams/roles.js";
import { assign_clusters, assign_intent_seams, _extract_suggested_seams, type Seam } from "../../ts/src/codebase/seams/clusters.js";
import { loadAddon, toResolvedGraph } from "../../ts/src/codebase/rust_core.js";

const addon = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");
const fixtures = join(REPO, "ts", "test", "fixtures");

// The wire: nodes as an ARRAY (see the note on `Graph` in ir.rs — a JSON object would reorder integer-like
// ids), only the fields the passes read.
const wire = (g: Graph) => ({
  nodes: [...g.nodes.values()].map((n) => ({
    id: n.id, label: n.label, file: n.file, kind: n.kind, enclosing: n.enclosing,
    complexity: n.complexity, role: n.role, role_confidence: n.role_confidence,
    group: n.group, intent: n.intent,
  })),
  edges: g.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, provenance: e.provenance, line: e.line ?? 0 })),
  anchor: g.anchor, anchors: g.anchors,
});

// ---- corpus ---------------------------------------------------------------------------------------------
const raw = new Map<Graph, any>();
const corpus: Array<{ name: string; data: any }> = [];

for (const f of readdirSync(fixtures).filter((f) => f.endsWith("-graph.json"))) {
  corpus.push({ name: f, data: JSON.parse(readFileSync(join(fixtures, f), "utf-8")) });
}

// grow footprints over each fixture repo + the seam repo itself
const build = (fn: string, ...args: any[]) => { try { return (addon as any)[fn](...args); } catch { return null; } };
const targets: Array<[string, string, string]> = [];
for (const d of readdirSync(fixtures).filter((d) => d.endsWith("-repo"))) {
  const repo = join(fixtures, d);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name === ".git" ? [] : walk(join(dir, e.name)))
      : /\.(ts|tsx|js|java|rb|py|go)$/.test(e.name) ? [join(dir, e.name).slice(repo.length + 1)] : []);
  for (const rel of walk(repo).slice(0, 12)) {
    const defs = build("defsInFile", rel, readFileSync(join(repo, rel), "utf-8")) ?? [];
    for (const d of (defs as any[]).slice(0, 6)) targets.push([repo, rel, d.name]);
  }
}
// the seam repo itself — the densest source of real fan-out
for (const rel of ["ts/src/codebase/seams/clusters.ts", "ts/src/codebase/graph.ts", "ts/src/core/graph_ir.ts",
                   "ts/src/codebase/detect.ts", "ts/src/codebase/engine_ctx.ts"]) {
  if (!existsSync(join(REPO, rel))) continue;
  const defs = build("defsInFile", rel, readFileSync(join(REPO, rel), "utf-8")) ?? [];
  for (const d of (defs as any[]).slice(0, 8)) targets.push([REPO, rel, d.name]);
}

for (const [repo, rel, sym] of targets) {
  for (const fn of ["buildConsumersGraph", "buildDependencyGraph"] as const) {
    // BOTH data-coupling settings. With it ON the graph carries shared-key crossings, which is the only way
    // `_is_crossing` / `_extract_suggested_seams` see anything at all — built without it, that whole pass
    // compares an empty answer to an empty answer.
    for (const dc of [false, true]) {
      const dto = build(fn, repo, rel, sym, null, dc);
      if (!dto) continue;
      let g: any; try { g = toResolvedGraph(dto); } catch { continue; }
      if ((g?.nodes?.length ?? 0) > 1) corpus.push({ name: `${fn}:${dc ? "dc" : "nodc"}:${rel}:${sym}`, data: g });
    }
  }
}

// ---- compare --------------------------------------------------------------------------------------------
let ok = 0, bad = 0, nonEmpty = 0, withSeams = 0, multiSeam = 0, sugMarked = 0;
const fails: string[] = [];
const norm = (x: any) => JSON.stringify(x);

const check = (name: string, pass: string, tsv: any, rsv: any) => {
  if (norm(tsv) === norm(rsv)) { ok++; return; }
  bad++;
  if (fails.length < 6) fails.push(`${pass} ${name}\n  TS: ${norm(tsv).slice(0, 500)}\n  RS: ${norm(rsv).slice(0, 500)}`);
};

for (const { name, data } of corpus) {
  const mk = () => from_resolved_graph(JSON.parse(JSON.stringify(data)));
  const g0 = mk();
  if (g0.nodes.size === 0) continue;
  nonEmpty++;

  // --- roles
  const gr = mk(); assign_roles(gr);
  const rsRoles = JSON.parse(addon.decomposeAssignRoles(JSON.stringify(wire(mk()))));
  check(name, "roles", [...gr.nodes.values()].map((n) => [n.id, n.role, n.role_confidence]),
        (rsRoles.nodes ?? []).map((n: any) => [n.id, n.role, n.role_confidence]));

  // --- clusters (run AFTER roles: the intent label reads n.role)
  const gc = mk(); assign_roles(gc); assign_clusters(gc);
  const rsC = JSON.parse(addon.decomposeAssignClusters(addon.decomposeAssignRoles(JSON.stringify(wire(mk())))));
  check(name, "clusters", [...gc.nodes.values()].map((n) => [n.id, n.group, n.intent]),
        (rsC.nodes ?? []).map((n: any) => [n.id, n.group, n.intent]));

  // --- intent seams
  const gs = mk(); assign_roles(gs); assign_clusters(gs);
  const tsSeams: Seam[] = assign_intent_seams(gs);
  const rolesJson = addon.decomposeAssignRoles(JSON.stringify(wire(mk())));
  const clustJson = addon.decomposeAssignClusters(rolesJson);
  const rsSeams = JSON.parse(addon.decomposeIntentSeams(clustJson));
  if (tsSeams.length) withSeams++;
  if (tsSeams.length > 1) multiSeam++;
  const sn = (s: any) => [s.id, s.label, s.linkOnly ?? s.link_only, s.proposedBy ?? s.proposed_by, s.node_ids];
  check(name, "seams", tsSeams.map(sn), rsSeams.map(sn));

  // --- suggested seams (fed the SAME input on both sides, so a seam drift can't masquerade as this one)
  const tsSug = _extract_suggested_seams(gs, JSON.parse(JSON.stringify(tsSeams)));
  const rsSug = JSON.parse(addon.decomposeSuggestedSeams(clustJson,
    JSON.stringify(tsSeams.map((s) => ({ id: s.id, label: s.label, link_only: s.linkOnly, node_ids: s.node_ids, proposed_by: s.proposedBy })))));
  if (tsSug.some((s) => s.suggested)) sugMarked++;
  const sg = (s: any) => [s.id, s.label, s.node_ids, s.suggested ?? null];
  check(name, "suggested", tsSug.map(sg), rsSug.map(sg));
}

console.log(`decompose parity: ${ok} ok / ${bad} bad   (graphs ${nonEmpty}/${corpus.length}, with-seams ${withSeams}, multi-seam ${multiSeam}, suggested-marked ${sugMarked})`);
for (const x of fails) console.log(x);
if (bad) process.exit(1);
