// Byte-identical harness — Rust find_reach vs TS findReach over Keycloak (dataCoupling off). Per file: a
// REACHABLE target (a dep of the class) + an UNREACHABLE target.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { findReach } from "../../ts/src/codebase/grow/reach.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "40", 10);
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512*1024*1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);
const classOf = (r: string) => r.slice(r.lastIndexOf("/") + 1, -5);
const ser = (r: any) => {
  const step = (s: any) => `${s.symbol}@${s.file}:${s.line}:${s.edgeKind ?? s.edge_kind}`;
  return `reachable=${r.reachable} reason=${r.reason} hops=${r.hops} nostruct=${(r.noStructure ?? r.no_structure)?1:0} path=[${r.path.map(step).join(" > ")}]`;
};
let ok=0,bad=0; const fails:string[]=[]; const t0=Date.now();
async function check(file: string, sym: string, to: string, toFile?: string) {
  const ts = await findReach(repo, file, sym, to, { toFile, dataCoupling: false });
  const rust = addon.findReach(repo, file, sym, to, toFile ?? null, null);
  if (ser(ts)===ser(rust)) ok++; else { bad++; if(fails.length<12) fails.push(`✗ ${file}#${sym} -> ${to}\n  ts:   ${ser(ts)}\n  rust: ${ser(rust)}`); }
}
for (let i=0;i<files.length;i++){
  const file=files[i]; const text=readFileSync(`${repo}/${file}`,"utf8"); if(!/^[\x00-\x7F]*$/.test(text)) continue;
  process.stdout.write(`[${i+1}/${files.length} ${((Date.now()-t0)/1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  const cls=classOf(file);
  // a reachable target: first dep of the class down-graph
  const dg = addon.buildDependencyGraph(repo, file, cls, null);
  const dep = (dg.nodes as any[]).find((n)=>n.id!=="n1" && n.symbol);
  if (dep) await check(file, cls, dep.symbol, dep.file);
  await check(file, cls, "NONEXISTENT_XYZ_TARGET_123");
}
console.log(`\nfind_reach parity: byte-identical ${ok} / mismatches ${bad}`);
if(fails.length) console.log("\n"+fails.join("\n"));
process.exit(bad?1:0);
