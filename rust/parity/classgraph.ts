// Byte-identical harness — Rust build_class_graph vs TS build_class_graph (STRUCTURAL core: dataCoupling
// OFF, depth 1 — coupling + depth-2 are later migration phases). Anchor = (java file, its class name).
// Compares the WHOLE graph: anchor, nodes, edges (incl. reference `line`), blindspots, unresolved.
//   bun rust/parity/classgraph.ts [repo] [maxAnchors]
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build_class_graph } from "../../ts/src/codebase/scan/up/class_graph.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxAnchors = parseInt(process.argv[3] ?? "400", 10);

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString()
  .split("\0")
  .filter(Boolean)
  .slice(0, maxAnchors);
const classOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1, -5);

const ser = (g: any) => {
  if (!g) return "<null>";
  const n = (x: any) => `N ${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}`;
  const e = (x: any) => `E ${x.from}->${x.to}|${x.kind}|${x.provenance}|${x.line ?? ""}`;
  const b = (x: any) => `B ${x.node}|${x.mechanism}|${x.evidence}|${(x.candidates ?? []).map((c: any) => (typeof c === "string" ? c : c.symbol)).join(",")}`;
  const u = (x: any) => `U ${x.node}|${x.query}|${x.reason}`;
  const aid = g.anchor?.id ?? g.anchorId, asym = g.anchor?.symbol ?? g.anchorSymbol;
  const afile = g.anchor?.file ?? g.anchorFile, arange = g.anchor?.range ?? g.anchorRange;
  return [
    `A ${aid}|${asym}|${afile}|${arange.join(",")}|${g.language}`,
    ...g.nodes.map(n),
    ...g.edges.map(e),
    ...g.blindspots.map(b),
    ...g.unresolved.map(u),
  ].join("\n");
};

let ok = 0, bad = 0, nonTrivial = 0, withBlind = 0;
const fails: string[] = [];
const t0 = Date.now();

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const cls = classOf(file);
  process.stdout.write(`[${i + 1}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  let ts: any;
  try { ts = await build_class_graph(repo, file, cls, { dataCoupling: false }); } catch { continue; }
  const rust = addon.buildClassGraph(repo, file, cls);
  if (ts.nodes.length > 1) nonTrivial++;
  if (ts.blindspots.length) withBlind++;
  const t = ser(ts), r = ser(rust);
  if (t === r) { ok++; continue; }
  bad++;
  if (fails.length < 12) {
    const tl = t.split("\n"), rl = r.split("\n");
    const k = tl.findIndex((l, j) => l !== rl[j]);
    fails.push(`✗ ${file}#${cls}\n    ts:   ${tl[k] ?? "<none>"}\n    rust: ${rl[k] ?? "<none>"}`);
  }
}

console.log(`\nbuild_class_graph parity over ${repo}`);
console.log(`  anchors: ${ok + bad}   non-trivial: ${nonTrivial}   with-blindspots: ${withBlind}`);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
