// Byte-identical harness — Rust build_dependency_graph vs TS (STRUCTURAL: dataCoupling OFF, and
// SEAM_QUALIFIED_CALLS=0 + SEAM_PROVIDER_HOP=0 since those two passes land next). Java anchors: class + method
// + function. Compares anchor, nodes, edges(+line), blindspots(node|mechanism|evidence|candidates|persists), anchors.


import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build_dependency_graph } from "../../ts/src/codebase/scan/down/dependency_graph.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "120", 10);
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512*1024*1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);
const cand = (c: any) => `${c.symbol ?? ""}:${c.file ?? ""}:${c.provenance ?? ""}`;
const ser = (g: any) => {
  const n = (x: any) => `N ${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}`;
  const e = (x: any) => `E ${x.from}->${x.to}|${x.kind}|${x.provenance}|${x.line ?? ""}`;
  const b = (x: any) => `B ${x.node}|${x.mechanism}|${x.evidence}|${(x.candidates ?? []).map(cand).join(",")}|${x.persists ? 1 : 0}`;
  const aid = g.anchor?.id ?? g.anchorId, arange = g.anchor?.range ?? g.anchorRange;
  return [`A ${aid}|${g.anchor?.symbol ?? g.anchorSymbol}|${g.anchor?.file ?? g.anchorFile}|${arange.join(",")}|${g.language}`,
    ...g.nodes.map(n), ...g.edges.map(e), ...g.blindspots.map(b), `ANCHORS ${(g.anchors ?? []).join(",")}`].join("\n");
};
let ok=0,bad=0,byKind:Record<string,number>={}; const fails:string[]=[]; const t0=Date.now();
async function check(file: string, symbol: string, tag: string) {
  let ts: any; try { ts = await build_dependency_graph(repo, file, symbol, { dataCoupling: false }); } catch { return; }
  const rust = addon.buildDependencyGraph(repo, file, symbol, null);
  byKind[tag]=(byKind[tag]??0)+1;
  if (ser(ts)===ser(rust)) ok++; else { bad++; if(fails.length<15){const tl=ser(ts).split("\n"),rl=ser(rust).split("\n");const k=tl.findIndex((l,j)=>l!==rl[j]);fails.push(`✗ ${file}#${symbol} [${tag}]\n  ts:   ${tl[k]??"<none>"}\n  rust: ${rl[k]??"<none>"}`);} }
}
for (let i=0;i<files.length;i++){
  const file=files[i]; const text=readFileSync(`${repo}/${file}`,"utf8"); if(!/^[\x00-\x7F]*$/.test(text)) continue;
  process.stdout.write(`[${i+1}/${files.length} ${((Date.now()-t0)/1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  const units = addon.namedUnits(text,"java") as any[];
  const cls=units.find((u)=>u.kind==="class"); const method=units.find((u)=>u.kind==="method");
  if(cls) await check(file, cls.name, "class");
  if(method) await check(file, method.name, "method");
}
console.log(`\nbuild_dependency_graph parity`, byKind, ` byte-identical: ${ok} mismatches: ${bad}`);
if(fails.length) console.log("\n"+fails.join("\n"));
process.exit(bad?1:0);
