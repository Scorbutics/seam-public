// AST parity — native Rust `typescript` grammar vs the web-tree-sitter typescript grammar Seam bundles, over
// a corpus of .ts files. Structure-level (kind+field) is the grammar-parity question; span-only diffs on
// non-ASCII files are the known napi re-encode artifact. If structure matches on ASCII, the ported TS scans
// will be byte-identical on TS just as they are on Java.
//   bun rust/parity/parity_ts.ts [dir] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { getParser } from "../../ts/src/core/treesitter.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const dir = process.argv[2] ?? "/home/scorbutics/seam-phase0/ts/src";
const maxFiles = parseInt(process.argv[3] ?? "300", 10);

function tsDump(node: any, depth: number, field: string, out: string[]): void {
  out.push(`${depth}|${field}|${node.type}|${node.startIndex}-${node.endIndex}`);
  const n = node.childCount;
  for (let i = 0; i < n; i++) tsDump(node.child(i), depth + 1, node.fieldNameForChild(i) ?? "", out);
}
const stripSpan = (s: string) => s.slice(0, s.lastIndexOf("|"));

const files = execFileSync("bash", ["-c", `cd ${dir} && git ls-files '*.ts' 2>/dev/null | head -${maxFiles} || find . -name '*.ts' | head -${maxFiles}`])
  .toString().split("\n").filter(Boolean);

const parser = await getParser("typescript");
if (!parser) throw new Error("no web-tree-sitter typescript grammar");

let structOk = 0, structBad = 0, fullOk = 0, asciiFiles = 0;
const fails: string[] = [];
for (const rel of files) {
  let src: string;
  try { src = readFileSync(`${dir}/${rel}`, "utf8"); } catch { continue; }
  const ascii = /^[\x00-\x7F]*$/.test(src);
  if (ascii) asciiFiles++;
  const rust: string[] = addon.parseKinds(src, "typescript");
  const tree = parser.parse(src);
  const ts: string[] = [];
  tsDump(tree.rootNode, 0, "", ts);
  const sameLen = rust.length === ts.length;
  let sOk = sameLen, fOk = sameLen;
  const n = Math.min(rust.length, ts.length);
  let firstDiff = -1;
  for (let i = 0; i < n; i++) {
    if (rust[i] !== ts[i]) fOk = false;
    if (stripSpan(rust[i]) !== stripSpan(ts[i])) { sOk = false; if (firstDiff < 0) firstDiff = i; }
  }
  if (sOk) structOk++; else { structBad++; if (fails.length < 12) fails.push(`✗ ${rel} (len rust=${rust.length} ts=${ts.length})\n    rust: ${rust[firstDiff] ?? "<none>"}\n    ts:   ${ts[firstDiff] ?? "<none>"}`); }
  if (fOk && ascii) fullOk++;
}

console.log(`\nTS grammar AST parity over ${dir}`);
console.log(`  files: ${structOk + structBad}   (ascii: ${asciiFiles})`);
console.log(`  STRUCTURE identical (kind+field): ${structOk}   divergent: ${structBad}`);
console.log(`  FULL identical (kind+field+span, ascii files): ${fullOk}`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(structBad ? 1 : 0);
