// Byte-identical harness — Rust project_neighborhood vs TS projectNeighborhood (dataCoupling off).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { projectNeighborhood } from "../../ts/src/codebase/grow/neighborhood.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "30", 10);
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512*1024*1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);
const classOf = (r: string) => r.slice(r.lastIndexOf("/") + 1, -5);
const ser = (n: any) => {
  const mf = (m: any) => `${m.file}|${m.symbols.join(",")}|${m.internal}|${m.external}|${m.core?1:0}`;
  return [`A ${n.anchor?.symbol ?? n.anchorSymbol} depth=${n.depth} bcut=${n.boundaryCut ?? n.boundary_cut} coh=${(n.cohesion).toFixed(6)} hops=${n.hops} nostruct=${(n.noStructure ?? n.no_structure)?1:0}`,
    ...n.members.map(mf), `CORE ${(n.coreFiles ?? n.core_files).join(",")}`, `PERIPH ${(n.peripheryFiles ?? n.periphery_files).join(",")}`].join("\n");
};
let ok=0,bad=0,nonTrivial=0; const fails:string[]=[]; const t0=Date.now();
for (let i=0;i<files.length;i++){
  const file=files[i]; const text=readFileSync(`${repo}/${file}`,"utf8"); if(!/^[\x00-\x7F]*$/.test(text)) continue;
  process.stdout.write(`[${i+1}/${files.length} ${((Date.now()-t0)/1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  const sym=classOf(file);
  const ts = await projectNeighborhood(repo, file, sym, { dataCoupling: false });
  const rust = addon.projectNeighborhood(repo, file, sym, null, null);
  if (ts.members.length>1) nonTrivial++;
  if (ser(ts)===ser(rust)) ok++; else { bad++; if(fails.length<12){const tl=ser(ts).split("\n"),rl=ser(rust).split("\n");const k=tl.findIndex((l,j)=>l!==rl[j]);fails.push(`✗ ${file}#${sym}\n  ts:   ${tl[k]??"<none>"}\n  rust: ${rl[k]??"<none>"}`);} }
}
console.log(`\nproject_neighborhood parity: byte-identical ${ok} / mismatches ${bad} (non-trivial ${nonTrivial})`);
if(fails.length) console.log("\n"+fails.join("\n"));
process.exit(bad?1:0);
