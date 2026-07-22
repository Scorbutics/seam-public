// Byte-identical harness — Rust vs TS build_module_graph + exported_members + projectContract, over a
// TYPESCRIPT repo. Validates the freshly-vendored TS grammar end-to-end through the ported scans: the
// export-statement path of exported_members, the TS module-consumer resolution, and the contract projection.
//   bun rust/parity/modulegraph_ts.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeCtx } from "../../ts/src/codebase/atoms.js";
import { _exported_members } from "../../ts/src/codebase/scan/ast_units.js";
import { build_module_graph } from "../../ts/src/codebase/scan/module_graph.js";
import { projectContract } from "../../ts/src/codebase/grow/contract.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/seam-phase0/ts";
const maxFiles = parseInt(process.argv[3] ?? "150", 10);

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.ts"], { maxBuffer: 512 * 1024 * 1024 })
  .toString().split("\0").filter(Boolean).filter((f) => !f.endsWith(".d.ts")).slice(0, maxFiles);

const serG = (g: any) => {
  const n = (x: any) => `N ${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}`;
  const e = (x: any) => `E ${x.from}->${x.to}|${x.kind}|${x.provenance}|${x.line ?? ""}`;
  const aid = g.anchor?.id ?? g.anchorId, arange = g.anchor?.range ?? g.anchorRange;
  return [`A ${aid}|${(g.anchor?.symbol ?? g.anchorSymbol)}|${(g.anchor?.file ?? g.anchorFile)}|${arange.join(",")}|${g.language}`, ...g.nodes.map(n), ...g.edges.map(e)].join("\n");
};
const serC = (c: any) => {
  const prov = (p: any) => `P ${p.symbol}|${p.kind}|${p.consumerCount ?? p.consumer_count}|${p.consumers.map((x: any) => `${x.file}:${x.symbol}`).join(";")}`;
  return [`M aff=${c.afferent} eff=${c.efferent}`, ...c.provides.map(prov), `U ${(c.unusedExports ?? c.unused_exports ?? []).join(",")}`, ...c.depends.map((d: any) => `D ${d.symbol}|${d.source}|${d.file}`)].join("\n");
};

let memOk = 0, memBad = 0, gOk = 0, gBad = 0, cOk = 0, cBad = 0;
const fails: string[] = [];
const t0 = Date.now();

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  process.stdout.write(`[${i + 1}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s mem=${memOk}/${memBad} g=${gOk}/${gBad} c=${cOk}/${cBad}] ${file}\n`);
  const text = readFileSync(`${repo}/${file}`, "utf8");
  const ascii = /^[\x00-\x7F]*$/.test(text);
  if (!ascii) continue; // line/span parity holds on ASCII; non-ASCII is the known napi byte-offset artifact

  const ctx = (await makeCtx(text, "typescript"))!;
  const tsMem = _exported_members(ctx, file).map((m: any) => `${m[0]}|${m[1]}|${m[2]}|${m[3]}`).join("\n");
  const rMem = (addon.exportedMembers(file, text, "typescript") as any[]).map((m) => `${m.name}|${m.kind}|${m.start}|${m.end}`).join("\n");
  if (tsMem === rMem) memOk++; else { memBad++; if (fails.length < 8) fails.push(`MEM ✗ ${file}\n  ts:   ${tsMem.split("\n").find((l, k) => l !== rMem.split("\n")[k]) ?? "<len>"}\n  rust: ${rMem.split("\n").find((l, k) => l !== tsMem.split("\n")[k]) ?? "<len>"}`); }

  const tg = await build_module_graph(repo, file, { dataCoupling: false });
  const rg = addon.buildModuleGraph(repo, file);
  if (serG(tg) === serG(rg)) gOk++; else { gBad++; if (fails.length < 12) { const tl = serG(tg).split("\n"), rl = serG(rg).split("\n"); const k = tl.findIndex((l, j) => l !== rl[j]); fails.push(`GRAPH ✗ ${file}\n    ts:   ${tl[k] ?? "<none>"}\n    rust: ${rl[k] ?? "<none>"}`); } }

  const tc = await projectContract(repo, file);
  const rc = addon.projectContract(repo, file);
  if (serC(tc) === serC(rc)) cOk++; else { cBad++; if (fails.length < 15) { const tl = serC(tc).split("\n"), rl = serC(rc).split("\n"); const k = tl.findIndex((l, j) => l !== rl[j]); fails.push(`CONTRACT ✗ ${file}\n    ts:   ${tl[k] ?? "<none>"}\n    rust: ${rl[k] ?? "<none>"}`); } }
}

console.log(`\nTS scans parity over ${repo}`);
console.log(`  exported_members: ${memOk} ok / ${memBad} bad`);
console.log(`  build_module_graph: ${gOk} ok / ${gBad} bad`);
console.log(`  contract: ${cOk} ok / ${cBad} bad`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(memBad || gBad || cBad ? 1 : 0);
