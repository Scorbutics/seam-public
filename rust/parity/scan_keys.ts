// Byte-identical harness — Rust scan_file_keys (all registered adapters) vs TS scan_file_keys, over Keycloak.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { scan_file_keys } from "../../ts/src/codebase/coupling/adapters/index.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "3000", 10);
const glob = (process.argv[4] ?? "*.java").split(" ");
const files = execFileSync("bash", ["-c", `cd ${repo} && git ls-files ${glob.map((g)=>`'${g}'`).join(" ")} | grep -v '\\.d\\.ts$' | head -${maxFiles}`]).toString().split("\n").filter(Boolean);
const ser = (hits: any[]) => hits.map((h) => `${h.kind}|${h.value}|${h.line}|${h.produces}|${h.op ?? ""}|${h.label ?? ""}|${h.method ?? ""}|${h.recv ?? ""}`).join(";");
const serR = (rows: string[][]) => rows.map((r) => r.join("|")).join(";");
let ok = 0, bad = 0, nonEmpty = 0, ascii = 0;
const fails: string[] = [];
for (const rel of files) {
  let text: string; try { text = readFileSync(`${repo}/${rel}`, "utf8"); } catch { continue; }
  if (!/^[\x00-\x7F]*$/.test(text)) continue;
  ascii++;
  const ts = scan_file_keys(rel, text);
  const rust = addon.scanFileKeys(rel, text) as string[][];
  if (ts.length) nonEmpty++;
  if (ser(ts) === serR(rust)) ok++; else { bad++; if (fails.length < 12) fails.push(`✗ ${rel}\n    ts:   ${ser(ts)}\n    rust: ${serR(rust)}`); }
}
console.log(`\nscan_file_keys parity over ${repo}  (${glob}) (ascii: ${ascii})`);
console.log(`  ${ok} ok / ${bad} bad   (non-empty: ${nonEmpty})`);
if (fails.length) console.log("\n" + fails.slice(0,8).join("\n"));
process.exit(bad ? 1 : 0);
