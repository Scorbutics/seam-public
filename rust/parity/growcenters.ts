// Byte-identical harness — Rust grow_centers vs TS grow_centers_scoped(floor) + the mergeOne merge loop.
import { createRequire } from "node:module";
import { grow_centers_scoped } from "../../ts/src/codebase/grow/orchestrate.js";
import { merge_resolved } from "../../ts/src/codebase/scan/index.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
process.env.SEAM_GRAPH_CACHE = "0"; // TS cache conflates same-name symbols
process.env.SEAM_CENTERS_MERGED = "0"; // the DEFAULT floor path (per-center grow + caller merge)
process.env.SEAM_PARALLEL_GROW = "0"; // Rust core is sequential (fc-ids); TS's couple_pool mints dc-ids in parallel
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxSets = parseInt(process.argv[3] ?? "20", 10);
const glob = process.argv[4] ?? "*.java";
const dataCoupling = (process.argv[5] ?? "false") === "true";
const MAX_NODES = 80, MAX_STEPS = 12;

// Build center-sets: files with ≥2 method defs → a 2-center set from that file (a real intra-module concern).
const defs = (addon.enumerateDefs(repo, 200000, undefined, false) as any[])
  .filter((d) => d.file.endsWith(glob.replace("*", "")) && d.kind === "method" && d.name && d.enclosing);
const byFile = new Map<string, any[]>();
for (const d of defs) { (byFile.get(d.file) ?? byFile.set(d.file, []).get(d.file)!).push(d); }
const sets: { file: string; symbol: string }[][] = [];
for (const [, ms] of byFile) {
  if (ms.length >= 2) sets.push([{ file: ms[0].file, symbol: ms[0].name }, { file: ms[1].file, symbol: ms[1].name }]);
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
for (const centers of chosen) {
  const ctx = new EngineCtx();
  const results = await grow_centers_scoped(repo, centers, { dataCoupling, dataCouplingLlm: false, structuralGrow: true, ctx, maxNodes: MAX_NODES, maxSteps: MAX_STEPS } as any);
  let data: any = null;
  for (let i = 0; i < results.length; i++) {
    if (data && (data.nodes?.length ?? 0) >= MAX_NODES) break;
    const r = results[i]; if (!r) continue;
    const [d] = r;
    data = data ? merge_resolved(data, d, d.anchor?.id) : d;
  }
  const a = ser(data);
  const b = ser(addon.growCenters(repo, centers, dataCoupling, MAX_STEPS, MAX_NODES));
  if (a === b) ok++;
  else {
    bad++;
    if (fails.length < 8) {
      const al = a.split("\n"), bl = b.split("\n");
      const k = al.findIndex((l, j) => l !== bl[j]);
      fails.push(`✗ ${centers.map((c) => c.symbol).join("+")} (${centers[0].file})\n  ts:   ${al[k] ?? "<none>"} [${al.length}]\n  rust: ${bl[k] ?? "<none>"} [${bl.length}]`);
    }
  }
}
console.log(`\ngrow_centers parity over ${glob} (dc=${dataCoupling}): ${ok} ok / ${bad} bad (sets ${chosen.length})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
