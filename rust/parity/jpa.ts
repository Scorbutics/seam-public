// Byte-identical harness — Rust JPA adapter vs TS JPA_ENTITY.scan over Keycloak Java.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { JPA_ENTITY } from "../../ts/src/codebase/coupling/adapters/jpa_entity.js";
import { makeMaskCtx } from "../../ts/src/codebase/coupling/adapters/util.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "2000", 10);
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);
const ser = (hits: any[]) => hits.map((h) => `${h.kind}|${h.value}|${h.line}|${h.produces}|${h.op ?? ""}`).join(";");
let ok = 0, bad = 0, nonEmpty = 0, ascii = 0;
const fails: string[] = [];
for (const rel of files) {
  let text: string; try { text = readFileSync(`${repo}/${rel}`, "utf8"); } catch { continue; }
  if (!/^[\x00-\x7F]*$/.test(text)) continue;
  ascii++;
  const ts = JPA_ENTITY.scan(rel, text, makeMaskCtx(text));
  const rustRows = addon.adapterKeys("jpa-entity", rel, text) as string[][];
  const rust = rustRows.map((r) => `${r[0]}|${r[1]}|${r[2]}|${r[3]}|${r[4]}`).join(";");
  if (ts.length) nonEmpty++;
  if (ser(ts) === rust) ok++; else { bad++; if (fails.length < 10) fails.push(`✗ ${rel}\n    ts:   ${ser(ts)}\n    rust: ${rust}`); }
}
console.log(`\nJPA adapter parity over ${repo}  (ascii: ${ascii})`);
console.log(`  ${ok} ok / ${bad} bad   (non-empty: ${nonEmpty})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
