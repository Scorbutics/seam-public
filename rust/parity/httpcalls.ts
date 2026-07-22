import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { inferHttpClients, resolveHttpCallSites } from "../../ts/src/codebase/coupling/effect_inference.js";
import { walkFiles } from "../../ts/src/core/resolve/walk.js";
import { SKIP_DIRS } from "../../ts/src/core/resolve/languages/index.js";
import { scannableForKeys } from "../../ts/src/codebase/coupling/adapters/index.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const glob = (process.argv[3] ?? "*.ts *.tsx *.js").split(" ");
const wfiles: {rel:string;text:string}[] = [];
for (const {rel,text} of walkFiles(repo, SKIP_DIRS, scannableForKeys, {})) wfiles.push({rel,text});
const clients = [...await inferHttpClients(wfiles)];
const files = execFileSync("bash",["-c",`cd ${repo} && git ls-files ${glob.map(g=>`'${g}'`).join(" ")} | grep -v '\\.d\\.ts$'`]).toString().split("\n").filter(Boolean);
let ok=0,bad=0,nonEmpty=0; const fails:string[]=[];
for(const rel of files){ let text:string; try{text=readFileSync(`${repo}/${rel}`,"utf8");}catch{continue;}
  if(!/^[\x00-\x7F]*$/.test(text)) continue;
  const ts=resolveHttpCallSites(rel,text,new Set(clients)).map(h=>`${h.kind}|${h.value}|${h.line}|${h.produces}`);
  const rust=addon.resolveHttpCallSites(rel,text,clients) as string[];
  if(ts.length)nonEmpty++;
  if(ts.join(";")===rust.join(";"))ok++; else {bad++; if(fails.length<8)fails.push(`✗ ${rel}\n  ts:   ${ts.join(";")}\n  rust: ${rust.join(";")}`);}
}
console.log(`\nresolveHttpCallSites over ${repo} (${glob}): ${ok} ok / ${bad} bad (non-empty ${nonEmpty}, clients ${clients.length})`);
if(fails.length)console.log("\n"+fails.join("\n"));
process.exit(bad?1:0);
