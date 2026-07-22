// Byte-identical harness — Rust mask (mask_comments / string_literals_only) vs TS maskComments /
// stringLiteralsOnly, over Java + TS files (ASCII: the char/UTF-16 walk agrees).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { maskComments, stringLiteralsOnly } from "../../ts/src/codebase/coupling/adapters/util.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "500", 10);
const files = execFileSync("bash", ["-c", `cd ${repo} && git ls-files '*.java' '*.ts' '*.tsx' | grep -v '\\.d\\.ts$' | head -${maxFiles}`]).toString().split("\n").filter(Boolean);
let cOk = 0, cBad = 0, sOk = 0, sBad = 0, ascii = 0;
const fails: string[] = [];
for (const rel of files) {
  let text: string; try { text = readFileSync(`${repo}/${rel}`, "utf8"); } catch { continue; }
  if (!/^[\x00-\x7F]*$/.test(text)) continue;
  ascii++;
  const tc = maskComments(text), rc = addon.maskComments(text);
  if (tc === rc) cOk++; else { cBad++; if (fails.length < 6) fails.push(`COMMENTS ✗ ${rel} (len ts=${tc.length} rust=${rc.length})`); }
  const ts = stringLiteralsOnly(text), rs = addon.stringLiteralsOnly(text);
  if (ts === rs) sOk++; else { sBad++; if (fails.length < 12) fails.push(`STRINGS ✗ ${rel} (len ts=${ts.length} rust=${rs.length})`); }
}
console.log(`\nmask parity over ${repo}  (ascii files: ${ascii})`);
console.log(`  mask_comments: ${cOk} ok / ${cBad} bad`);
console.log(`  string_literals_only: ${sOk} ok / ${sBad} bad`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(cBad || sBad ? 1 : 0);
