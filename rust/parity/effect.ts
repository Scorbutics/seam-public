// Byte-identical harness — Rust infer_http_clients vs TS inferHttpClients over Keycloak's scannable files.
import { createRequire } from "node:module";
import { inferHttpClients } from "../../ts/src/codebase/coupling/effect_inference.js";
import { walkFiles } from "../../ts/src/core/resolve/walk.js";
import { SKIP_DIRS } from "../../ts/src/core/resolve/languages/index.js";
import { scannableForKeys } from "../../ts/src/codebase/coupling/adapters/index.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const files: {rel:string;text:string}[] = [];
for (const {rel,text} of walkFiles(repo, SKIP_DIRS, scannableForKeys, {})) files.push({rel,text});
const ts = [...await inferHttpClients(files)];
const rust = addon.inferHttpClients(repo) as string[];
console.log(`\ninferHttpClients over ${repo}: ts=${ts.length} rust=${rust.length}`);
const setEq = ts.length===rust.length && ts.every((t,i)=>t===rust[i]);
console.log(setEq ? "  byte-identical ✓ (same order)" : "  MISMATCH");
if(!setEq){
  const ss=new Set(ts), rs=new Set(rust);
  console.log("  ts-only:", ts.filter(t=>!rs.has(t)).slice(0,15));
  console.log("  rust-only:", rust.filter(r=>!ss.has(r)).slice(0,15));
  // first order diff
  for(let i=0;i<Math.max(ts.length,rust.length);i++) if(ts[i]!==rust[i]){console.log(`  order diff @${i}: ts=${ts[i]} rust=${rust[i]}`);break;}
}
process.exit(setEq?0:1);
