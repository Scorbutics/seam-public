// Byte-identical harness — Rust build_callsite_graph vs TS build_callsite_graph. Two anchor kinds per file:
//   (a) CLASS anchor  — symbol = the file's class, opts={} → owner=null (all edges PARTIAL); exercises
//       candidate discovery + dedup + enclosing over the whole method set.
//   (b) METHOD anchor — symbol = one method of that class, methodNames={m} → owner=enclosing class;
//       exercises the FULL-promotion + sibling/static/foreign DROP provenance.
//   bun rust/parity/callsite.ts [repo] [maxAnchors]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build_callsite_graph } from "../../ts/src/codebase/scan/up/class_graph.js";

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

// Canonical serialization of a ResolvedGraph — every field build_consumers_graph consumes.
const ser = (g: any) => {
  if (!g) return "<null>";
  const n = (x: any) => `${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}`;
  const e = (x: any) => `${x.from}->${x.to}|${x.kind}|${x.provenance}`;
  // TS nests anchor as g.anchor.{id,symbol,file,range}; the Rust DTO flattens to anchor_* fields.
  const aid = g.anchor?.id ?? g.anchorId, asym = g.anchor?.symbol ?? g.anchorSymbol;
  const afile = g.anchor?.file ?? g.anchorFile, arange = g.anchor?.range ?? g.anchorRange;
  return [
    `anchor:${aid}|${asym}|${afile}|${arange.join(",")}|${g.language}`,
    ...g.nodes.map(n),
    ...g.edges.map(e),
    `resolved:${(g.resolvedMethods ?? g.resolved_methods ?? []).join(",")}`,
  ].join("\n");
};

let ok = 0, bad = 0, nonTrivial = 0;
const fails: string[] = [];

async function check(file: string, symbol: string, opts: any, rustArgs: any[]) {
  let ts: any, rust: any;
  try { ts = await build_callsite_graph(repo, file, symbol, opts); } catch { return; } // unparseable anchor — skip both
  rust = addon.buildCallsiteGraph(repo, file, symbol, ...rustArgs);
  const t = ser(ts), r = ser(rust);
  if (ts.nodes.length > 1) nonTrivial++;
  if (t === r) { ok++; return; }
  bad++;
  if (fails.length < 12) {
    const tl = t.split("\n"), rl = r.split("\n");
    const i = tl.findIndex((l, k) => l !== rl[k]);
    fails.push(`✗ ${file}#${symbol} ${JSON.stringify(opts)}\n    ts:   ${tl[i] ?? "<none>"}\n    rust: ${rl[i] ?? "<none>"}`);
  }
}

const t0 = Date.now();
let n = 0;
for (const file of files) {
  const cls = classOf(file);
  process.stdout.write(`[${++n}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  // (a) class anchor
  await check(file, cls, {}, [null, null, null]);
  // (b) a method anchor — first method unit whose enclosing is the class
  const text = readFileSync(`${repo}/${file}`, "utf8");
  const units = addon.namedUnits(text, "java") as any[];
  const method = units.find((u) => u.kind === "method");
  if (method) {
    await check(file, method.name, { methodNames: new Set([method.name]) }, [null, [method.name], null]);
  }
}

console.log(`\nbuild_callsite_graph parity over ${repo}`);
console.log(`  anchors: ${ok + bad}   non-trivial (consumers found): ${nonTrivial}`);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
