// Byte-identical harness — Rust build_dependency_graph({dataCoupling:true}) vs TS: the FULL down builder + the
// dataCoupling OVERLAY (resolveCoupling + route-consumer chaining). Compares nodes(+coupling/direction),
// edges(+op), blindspots. Shared EngineCtx warms the coupling caches across anchors (like the Rust statics).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build_dependency_graph } from "../../ts/src/codebase/scan/down/dependency_graph.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "60", 10);
const glob = process.argv[4] ?? "*.java";
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", glob], { maxBuffer: 512*1024*1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);
const cand = (c: any) => `${c.symbol ?? ""}:${c.file ?? ""}:${c.provenance ?? ""}`;
const ser = (g: any) => {
  const n = (x: any) => `N ${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}|${x.coupling?1:0}|${x.direction ?? ""}`;
  const e = (x: any) => `E ${x.from}->${x.to}|${x.kind}|${x.provenance}|${x.line ?? ""}|${x.op ?? ""}`;
  const b = (x: any) => `B ${x.node}|${x.mechanism}|${x.evidence}|${(x.candidates ?? []).map(cand).join(",")}|${x.persists ? 1 : 0}`;
  const aid = g.anchor?.id ?? g.anchorId, arange = g.anchor?.range ?? g.anchorRange;
  return [`A ${aid}|${g.anchor?.symbol ?? g.anchorSymbol}|${g.anchor?.file ?? g.anchorFile}|${arange.join(",")}|${g.language}`,
    ...g.nodes.map(n), ...g.edges.map(e), ...g.blindspots.map(b), `ANCHORS ${(g.anchors ?? []).join(",")}`].join("\n");
};
const lang = glob.includes(".ts") ? "typescript" : "java";
const ctx = new EngineCtx();
let ok=0,bad=0,ne=0; const fails:string[]=[]; const t0=Date.now();
async function check(file: string, symbol: string, tag: string) {
  let ts: any; try { ts = await build_dependency_graph(repo, file, symbol, { dataCoupling: true, llm: false, ctx }); } catch(e){ return; }
  const rust = addon.buildDependencyGraph(repo, file, symbol, null, true);
  if (ts.nodes.length > 1) ne++;
  if (ser(ts)===ser(rust)) ok++; else { bad++; if(fails.length<12){const tl=ser(ts).split("\n"),rl=ser(rust).split("\n");const k=tl.findIndex((l,j)=>l!==rl[j]);fails.push(`✗ ${file}#${symbol} [${tag}]\n  ts:   ${tl[k]??"<none>"}\n  rust: ${rl[k]??"<none>"}`);} }
}
for (let i=0;i<files.length;i++){
  const file=files[i]; const text=readFileSync(`${repo}/${file}`,"utf8"); if(!/^[\x00-\x7F]*$/.test(text)) continue;
  const units = addon.namedUnits(text,lang) as any[];
  const cls=units.find((u)=>u.kind==="class"); const method=units.find((u)=>u.kind==="method");
  if(cls) await check(file, cls.name, "class");
  if(method) await check(file, method.name, "method");
}
console.log(`\nbuild_dependency_graph({dataCoupling:true}) parity over ${glob}: ${ok} ok / ${bad} bad (non-trivial ${ne})`);
if(fails.length) console.log("\n"+fails.join("\n"));
process.exit(bad?1:0);
