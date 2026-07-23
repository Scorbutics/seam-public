// Byte-identical harness — Rust def_table (defs_in_file regex + defs_in_file_treesitter) vs TS, per file.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { defs_in_file, module_def } from "../../ts/src/codebase/scan/def_table.js";
import { defs_in_file_treesitter } from "../../ts/src/codebase/scan/def_treesitter.js";
import { hasValidatedRegexDefs } from "../../ts/src/core/resolve/languages/index.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "80", 10);
const glob = process.argv[4] ?? "*.java";
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", glob], { maxBuffer: 512 * 1024 * 1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);

const ser = (d: any) => `${d.name}|${d.kind}|${d.file}|${d.signature}|${d.enclosing}|${d.doc}|${d.body ?? ""}`;
const tsDefs = async (rel: string, text: string): Promise<any[]> => {
  const defs = hasValidatedRegexDefs(rel) ? defs_in_file(rel, text) : ((await defs_in_file_treesitter(rel, text)) ?? defs_in_file(rel, text));
  return [...defs, module_def(rel, text)];
};

let ok = 0, bad = 0, ne = 0; const fails: string[] = [];
for (const rel of files) {
  const text = readFileSync(`${repo}/${rel}`, "utf8");
  const ts = (await tsDefs(rel, text)).map(ser);
  const rust = (addon.defsInFile(rel, text, true) as any[]).map(ser);
  if (ts.length > 1) ne++;
  const a = ts.join("\n"), b = rust.join("\n");
  if (a === b) ok++;
  else { bad++; if (fails.length < 12) { const tl = a.split("\n"), rl = b.split("\n"); const k = tl.findIndex((l, j) => l !== rl[j]); fails.push(`✗ ${rel} (ts ${ts.length} / rust ${rust.length})\n  ts:   ${tl[k] ?? "<none>"}\n  rust: ${rl[k] ?? "<none>"}`); } }
}
console.log(`\ndef_table parity over ${glob}: ${ok} ok / ${bad} bad (non-trivial ${ne})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
