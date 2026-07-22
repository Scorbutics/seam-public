// Byte-identical harness — Rust vs TS build_consumers_graph over a TYPESCRIPT repo. Exercises the symbol-
// anchor paths on TS: function/class/method routing, build_class_graph on TS, and build_callsite_graph (the
// callsite index over TS files). Anchors = real exported members (class + first function) per file.
//   bun rust/parity/consumersgraph_ts.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build_consumers_graph } from "../../ts/src/codebase/scan/up/consumers_graph.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "40", 10);

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.ts"], { maxBuffer: 512 * 1024 * 1024 })
  .toString().split("\0").filter(Boolean).filter((f) => !f.endsWith(".d.ts")).slice(0, maxFiles);

const ser = (g: any) => {
  const n = (x: any) => `N ${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}`;
  const e = (x: any) => `E ${x.from}->${x.to}|${x.kind}|${x.provenance}|${x.line ?? ""}`;
  const b = (x: any) => `B ${x.node}|${x.mechanism}|${x.evidence}`;
  const aid = g.anchor?.id ?? g.anchorId, arange = g.anchor?.range ?? g.anchorRange;
  return [`A ${aid}|${(g.anchor?.symbol ?? g.anchorSymbol)}|${(g.anchor?.file ?? g.anchorFile)}|${arange.join(",")}|${g.language}`,
    ...g.nodes.map(n), ...g.edges.map(e), ...g.blindspots.map(b), `ANCHORS ${(g.anchors ?? []).join(",")}`].join("\n");
};

let ok = 0, bad = 0, byKind: Record<string, number> = {};
const fails: string[] = [];
const t0 = Date.now();

async function check(file: string, symbol: string, tag: string) {
  let ts: any;
  try { ts = await build_consumers_graph(repo, file, symbol, { dataCoupling: false }); } catch { return; }
  const rust = addon.buildConsumersGraph(repo, file, symbol, null);
  byKind[tag] = (byKind[tag] ?? 0) + 1;
  if (ser(ts) === ser(rust)) { ok++; return; }
  bad++;
  if (fails.length < 15) { const tl = ser(ts).split("\n"), rl = ser(rust).split("\n"); const k = tl.findIndex((l, j) => l !== rl[j]); fails.push(`✗ ${file}#${symbol} [${tag}]\n    ts:   ${tl[k] ?? "<none>"}\n    rust: ${rl[k] ?? "<none>"}`); }
}

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const text = readFileSync(`${repo}/${file}`, "utf8");
  if (!/^[\x00-\x7F]*$/.test(text)) continue; // ASCII only
  process.stdout.write(`[${i + 1}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  const members = addon.exportedMembers(file, text, "typescript") as any[];
  const cls = members.find((m) => m.kind === "class");
  const fn = members.find((m) => m.kind === "function");
  if (cls) await check(file, cls.name, "class");
  if (fn) await check(file, fn.name, "function");
}

console.log(`\nbuild_consumers_graph (TS) parity over ${repo}`);
console.log(`  by kind:`, byKind, `  byte-identical: ${ok}   mismatches: ${bad}`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
