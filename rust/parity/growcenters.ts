// Byte-identical harness — Rust grow_centers vs TS grow_centers_scoped(floor) + the mergeOne merge loop.
import { createRequire } from "node:module";
import { grow_centers_scoped } from "../../ts/src/codebase/grow/orchestrate.js";
// merge_resolved is the CORE's now — this harness imported it from `codebase/scan/`, which the migration
// deleted, so the harness has not run since. That is worth saying plainly: its "byte-identical" claim went
// stale the day the scan layer went, and any drift in `grow_centers` between then and now was unmeasured.
import { loadAddon, toResolvedGraph, toGraphDto } from "../../ts/src/codebase/rust_core.js";
const _core = (): any => { const a = loadAddon(); if (!a) throw new Error("the Seam core is not available"); return a; };
const merge_resolved = (base: any, add: any, expandAnchor?: string | null): any =>
  toResolvedGraph(_core().mergeResolved(toGraphDto(base), toGraphDto(add), expandAnchor ?? null));
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
process.env.SEAM_GRAPH_CACHE = "0"; // TS cache conflates same-name symbols
// COMPARE THE PATH THE PRODUCT RUNS. This said "the DEFAULT floor path" and set 0 — but the CLI sets
// SEAM_CENTERS_MERGED=1 (cli/decompose.ts), so the harness was verifying Rust against a path production does
// not use. That is how a real divergence hid in plain sight: the merged path ignored the global node budget
// (155 nodes for a 2-center concern at --max-nodes 80) while Rust enforced it, and this harness stayed green
// throughout because it never grew that path. Both are compared now, default FIRST.
const MERGED_MODES = (process.argv[6] ?? "1,0").split(",");
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxSets = parseInt(process.argv[3] ?? "20", 10);
const glob = process.argv[4] ?? "*.java";
const dataCoupling = (process.argv[5] ?? "false") === "true";
const MAX_NODES = parseInt(process.env.PARITY_MAX_NODES ?? "80", 10), MAX_STEPS = 12;

// Build center-sets: files with ≥2 method defs → a 2-center set from that file (a real intra-module concern).
const defs = (addon.enumerateDefs(repo, 200000, undefined, false) as any[])
  .filter((d) => d.file.endsWith(glob.replace("*", "")) && d.kind === "method" && d.name && d.enclosing);
const byFile = new Map<string, any[]>();
for (const d of defs) { (byFile.get(d.file) ?? byFile.set(d.file, []).get(d.file)!).push(d); }
// CENTER SETS SPAN FILES. This built both centers from the SAME file, whose closures overlap so heavily that
// the merge dedups away any budget excess — so the harness could not see a missing global budget check at
// all: with the check removed it stayed green on same-file pairs while a cross-file pair returned 155 nodes
// against a budget of 80. A concern's mechanism cluster is spread across files; the corpus must be too.
const files = [...byFile.keys()].sort();
const sets: { file: string; symbol: string }[][] = [];
for (let i = 0; i + 1 < files.length; i += 2) {
  const a = byFile.get(files[i])!, b = byFile.get(files[i + 1])!;
  sets.push([{ file: a[0].file, symbol: a[0].name }, { file: b[0].file, symbol: b[0].name }]);
}
const step = Math.max(1, Math.floor(sets.length / maxSets));
const chosen = sets.filter((_, i) => i % step === 0).slice(0, maxSets);

const ser = (g: any) => {
  if (!g) return "<null>";
  const nodes = (g.nodes ?? []).map((n: any) => `${n.id}|${n.symbol}|${n.file}|${n.kind}|${(n.range ?? [0, 0]).join(",")}|${n.enclosing ?? ""}`);
  const edges = (g.edges ?? []).map((e: any) => `${e.from}>${e.to}|${e.kind}|${e.provenance}|${e.line ?? ""}`);
  return [`nodes[${nodes.length}]`, ...nodes, `edges[${edges.length}]`, ...edges, `anchors=${(g.anchors ?? []).join(",")}`].join("\n");
};

let ok = 0, bad = 0; const fails: string[] = [];
for (const merged of MERGED_MODES) {
  process.env.SEAM_CENTERS_MERGED = merged;
  for (const centers of chosen) {
    const ctx = new EngineCtx();
    const results = await grow_centers_scoped(repo, centers, { dataCoupling, dataCouplingLlm: false, structuralGrow: true, ctx, maxNodes: MAX_NODES, maxSteps: MAX_STEPS } as any);
    let data: any = null;
    // merged=1 returns ONE already-merged graph; merged=0 returns one result per center and the CALLER
    // merges under the budget (decompose.ts's mergeOne loop), which is what is reproduced here.
    for (let i = 0; i < results.length; i++) {
      if (data && (data.nodes?.length ?? 0) >= MAX_NODES) break;
      const r = results[i]; if (!r) continue;
      const [d] = r;
      data = data ? merge_resolved(data, d, d.anchor?.id) : d;
    }
    const a = ser(data);
    // OPTS IS AN OBJECT, not positional. This passed `MAX_STEPS, MAX_NODES` as two trailing arguments;
      // napi silently coerced them to a DEFAULT GrowOptsDto and ignored both. It agreed with TypeScript only
      // because MAX_NODES here is 80, which happens to BE the default — proved by
      // `growCenters(repo, centers, false, 12, 20)` returning 80 nodes where the object form returns 47.
      const b = ser(addon.growCenters(repo, centers, dataCoupling, { maxSteps: MAX_STEPS, maxNodes: MAX_NODES }));
    if (a === b) ok++;
    else {
      bad++;
      if (fails.length < 8) {
        const al = a.split("\n"), bl = b.split("\n");
        const k = al.findIndex((l, j) => l !== bl[j]);
        fails.push(`✗ merged=${merged} ${centers.map((c) => c.symbol).join("+")} (${centers[0].file})\n  ts:   ${al[k] ?? "<none>"} [${al.length}]\n  rust: ${bl[k] ?? "<none>"} [${bl.length}]`);
      }
    }
  }
}
console.log(`\ngrow_centers parity over ${glob} (dc=${dataCoupling}, merged=${MERGED_MODES.join("+")}): ${ok} ok / ${bad} bad (sets ${chosen.length})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
