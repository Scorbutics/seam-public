// Byte-identical harness — Rust project_compare vs TS projectCompare (dataCoupling off). Compares consecutive
// class anchors.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { projectCompare } from "../../ts/src/codebase/grow/compare.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxPairs = parseInt(process.argv[3] ?? "40", 10);
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512*1024*1024 }).toString().split("\0").filter(Boolean);
const classOf = (r: string) => r.slice(r.lastIndexOf("/") + 1, -5);
const dep = (d: any) => `${d.file}:${d.symbol}:${d.kind}`;
const ser = (c: any) => [`sim=${c.similarity.toFixed(6)} nostruct=${(c.noStructure ?? c.no_structure)?1:0}`,
  `SHARED ${c.shared.map(dep).join(";")}`, `AONLY ${(c.aOnly ?? c.a_only).map(dep).join(";")}`, `BONLY ${(c.bOnly ?? c.b_only).map(dep).join(";")}`].join("\n");
let ok=0,bad=0; const fails:string[]=[]; const t0=Date.now();
for (let i=0;i<Math.min(maxPairs, files.length-1);i++){
  const [fa,fb]=[files[i],files[i+1]];
  const ta=readFileSync(`${repo}/${fa}`,"utf8"), tb=readFileSync(`${repo}/${fb}`,"utf8");
  if(!/^[\x00-\x7F]*$/.test(ta)||!/^[\x00-\x7F]*$/.test(tb)) continue;
  const [sa,sb]=[classOf(fa),classOf(fb)];
  process.stdout.write(`[${i+1} ${((Date.now()-t0)/1000).toFixed(0)}s ok=${ok} bad=${bad}] ${sa} vs ${sb}\n`);
  const ts=await projectCompare(repo,fa,sa,fb,sb,{dataCoupling:false});
  const rust=addon.projectCompare(repo,fa,sa,fb,sb,null);
  if(ser(ts)===ser(rust)) ok++; else { bad++; if(fails.length<10){const a=ser(ts).split("\n"),b=ser(rust).split("\n");const k=a.findIndex((l,j)=>l!==b[j]);fails.push(`✗ ${sa} vs ${sb}\n  ts:   ${a[k]}\n  rust: ${b[k]}`);} }
}
console.log(`\nproject_compare parity: byte-identical ${ok} / mismatches ${bad}`);
if(fails.length) console.log("\n"+fails.join("\n"));
process.exit(bad?1:0);
