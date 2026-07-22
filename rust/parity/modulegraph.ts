// Byte-identical harness — Rust build_module_graph vs TS build_module_graph (STRUCTURAL core: dataCoupling
// OFF). Anchor = a whole Java file (module mode). Also spot-checks exported_members (public_surface path).
// Compares anchor, nodes, edges. NB: only the Java grammar is vendored, so this validates the exportless
// (public_surface) path; the export-statement path awaits the TS grammar.
//   bun rust/parity/modulegraph.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeCtx } from "../../ts/src/codebase/atoms.js";
import { _exported_members } from "../../ts/src/codebase/scan/ast_units.js";
import { build_module_graph } from "../../ts/src/codebase/scan/module_graph.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "300", 10);

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString().split("\0").filter(Boolean).slice(0, maxFiles);

const ser = (g: any) => {
  const n = (x: any) => `N ${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}`;
  const e = (x: any) => `E ${x.from}->${x.to}|${x.kind}|${x.provenance}|${x.line ?? ""}`;
  const aid = g.anchor?.id ?? g.anchorId, asym = g.anchor?.symbol ?? g.anchorSymbol;
  const afile = g.anchor?.file ?? g.anchorFile, arange = g.anchor?.range ?? g.anchorRange;
  return [`A ${aid}|${asym}|${afile}|${arange.join(",")}|${g.language}`, ...g.nodes.map(n), ...g.edges.map(e)].join("\n");
};

let ok = 0, bad = 0, memOk = 0, memBad = 0, nonTrivial = 0;
const fails: string[] = [];
const t0 = Date.now();

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  process.stdout.write(`[${i + 1}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  const text = readFileSync(`${repo}/${file}`, "utf8");
  // exported_members isolation check
  const ctx = (await makeCtx(text, "java"))!;
  const tsMem = _exported_members(ctx, file).map((m: any) => `${m[0]}|${m[1]}|${m[2]}|${m[3]}`).join("\n");
  const rMem = (addon.exportedMembers(file, text, "java") as any[]).map((m) => `${m.name}|${m.kind}|${m.start}|${m.end}`).join("\n");
  if (tsMem === rMem) memOk++; else { memBad++; if (fails.length < 6) fails.push(`MEMBERS ✗ ${file}\n  ts:   ${tsMem.split("\n").find((l, k) => l !== rMem.split("\n")[k]) ?? "<len>"}\n  rust: ${rMem.split("\n").find((l, k) => l !== tsMem.split("\n")[k]) ?? "<len>"}`); }

  const ts = await build_module_graph(repo, file, { dataCoupling: false });
  const rust = addon.buildModuleGraph(repo, file);
  if (ts.nodes.length > 1) nonTrivial++;
  const t = ser(ts), r = ser(rust);
  if (t === r) { ok++; continue; }
  bad++;
  if (fails.length < 12) {
    const tl = t.split("\n"), rl = r.split("\n");
    const k = tl.findIndex((l, j) => l !== rl[j]);
    fails.push(`GRAPH ✗ ${file}\n    ts:   ${tl[k] ?? "<none>"}\n    rust: ${rl[k] ?? "<none>"}`);
  }
}

console.log(`\nbuild_module_graph parity over ${repo}`);
console.log(`  exported_members: ${memOk} ok / ${memBad} bad`);
console.log(`  module graph: ${ok} ok / ${bad} bad   (non-trivial: ${nonTrivial})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad || memBad ? 1 : 0);
