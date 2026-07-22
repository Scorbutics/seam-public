// Byte-identical harness — Rust load_matchers+run_matcher (the CACHE replay) vs TS loadMatchers+runMatcher,
// over Keycloak files. Validates the persisted `.seam/key-adapters.json` rules replay identically.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadMatchers } from "../../ts/src/codebase/coupling/key_store.js";
import { runMatcher } from "../../ts/src/codebase/coupling/key_ir.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "4000", 10);
const glob = (process.argv[4] ?? "*.java *.ts *.tsx").split(" ");

const matchers = loadMatchers(repo);
console.log(`loaded ${matchers.length} matchers`);
const files = execFileSync("bash", ["-c", `cd ${repo} && git ls-files ${glob.map((g) => `'${g}'`).join(" ")} | grep -v '\\.d\\.ts$' | head -${maxFiles}`]).toString().split("\n").filter(Boolean);

let ok = 0, bad = 0, nonEmpty = 0, ascii = 0;
const fails: string[] = [];
for (const rel of files) {
  let text: string; try { text = readFileSync(`${repo}/${rel}`, "utf8"); } catch { continue; }
  if (!/^[\x00-\x7F]*$/.test(text)) continue;
  ascii++;
  const tsHits: string[] = [];
  for (const m of matchers) for (const h of await runMatcher(m, rel, text)) tsHits.push(`${h.kind}|${h.value}|${h.line}|${h.produces}|${h.op ?? ""}`);
  const rust = addon.matcherKeys(repo, rel, text) as string[];
  if (tsHits.length) nonEmpty++;
  if (tsHits.join(";") === rust.join(";")) ok++;
  else { bad++; if (fails.length < 12) fails.push(`✗ ${rel}\n    ts:   ${tsHits.join(";")}\n    rust: ${rust.join(";")}`); }
}
console.log(`\nmatcher replay parity over ${repo} (${glob}) ascii=${ascii}`);
console.log(`  ${ok} ok / ${bad} bad   (non-empty: ${nonEmpty})`);
if (fails.length) console.log("\n" + fails.slice(0, 8).join("\n"));
process.exit(bad ? 1 : 0);
