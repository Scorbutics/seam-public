import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileStoreWriteCount } from "../../ts/src/codebase/coupling/index.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "3000", 10);
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512*1024*1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);
let ok=0,bad=0,nonZero=0; const fails:string[]=[];
for (const rel of files) {
  const ts = fileStoreWriteCount(repo, rel);
  const rust = addon.fileStoreWriteCount(repo, rel);
  if (ts>0) nonZero++;
  if (ts===rust) ok++; else { bad++; if(fails.length<10) fails.push(`✗ ${rel} ts=${ts} rust=${rust}`); }
}
console.log(`\nfileStoreWriteCount parity: ${ok} ok / ${bad} bad (non-zero: ${nonZero})`);
if(fails.length) console.log(fails.join("\n"));
process.exit(bad?1:0);
