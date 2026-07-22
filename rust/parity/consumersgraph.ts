// Byte-identical harness — Rust build_consumers_graph vs TS build_consumers_graph (STRUCTURAL core:
// dataCoupling OFF, depth 1). Per Java file, THREE anchor kinds to exercise every route:
//   (a) the CLASS            → build_class_graph + call-site merge + reconcile
//   (b) a METHOD of it       → import scan + method call-site merge
//   (c) an INTERFACE (if the file declares one) → import scan + interface call-site merge
// Compares the WHOLE graph: anchor, nodes, edges (incl. line), blindspots, unresolved, anchors.
//   bun rust/parity/consumersgraph.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build_consumers_graph } from "../../ts/src/codebase/scan/up/consumers_graph.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "80", 10);

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString().split("\0").filter(Boolean).slice(0, maxFiles);
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
    ...g.nodes.map(n), ...g.edges.map(e), ...g.blindspots.map(b), ...g.unresolved.map(u),
    `ANCHORS ${(g.anchors ?? []).join(",")}`,
  ].join("\n");
};

let ok = 0, bad = 0, byKind: Record<string, number> = { class: 0, method: 0, interface: 0 };
const fails: string[] = [];
const t0 = Date.now();

async function check(file: string, symbol: string, tag: string) {
  let ts: any;
  try { ts = await build_consumers_graph(repo, file, symbol, { dataCoupling: false }); } catch { return; }
  const rust = addon.buildConsumersGraph(repo, file, symbol, null);
  const t = ser(ts), r = ser(rust);
  byKind[tag] = (byKind[tag] ?? 0) + 1;
  if (t === r) { ok++; return; }
  bad++;
  if (fails.length < 15) {
    const tl = t.split("\n"), rl = r.split("\n");
    const k = tl.findIndex((l, j) => l !== rl[j]);
    fails.push(`✗ ${file}#${symbol} [${tag}]\n    ts:   ${tl[k] ?? "<none>"}\n    rust: ${rl[k] ?? "<none>"}`);
  }
}

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  process.stdout.write(`[${i + 1}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  const text = readFileSync(`${repo}/${file}`, "utf8");
  const units = addon.namedUnits(text, "java") as any[];
  await check(file, classOf(file), "class");
  const method = units.find((u) => u.kind === "method");
  if (method) await check(file, method.name, "method");
}

console.log(`\nbuild_consumers_graph parity over ${repo}`);
console.log(`  by kind:`, byKind);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
