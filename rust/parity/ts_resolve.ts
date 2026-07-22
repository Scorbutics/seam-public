// PHASE 1 byte-identical harness — Rust TypeScriptResolver vs TS _resolve, over real TS/JS imports.
//   bun rust/parity/ts_resolve.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { parse_imports } from "../../ts/src/core/resolve/languages/index.js";
import { _resolve } from "../../ts/src/core/resolve/consumers.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/.seam";
const maxFiles = parseInt(process.argv[3] ?? "3000", 10);

const files = execFileSync(
  "git",
  ["-C", repo, "ls-files", "-z", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.cts", "*.mjs", "*.cjs"],
  { maxBuffer: 512 * 1024 * 1024 },
)
  .toString()
  .split("\0")
  .filter(Boolean)
  .filter((f) => !f.includes("node_modules"));

const queries: [string, string][] = [];
for (const rel of files.slice(0, maxFiles)) {
  let text: string;
  try {
    text = readFileSync(`${repo}/${rel}`, "utf-8");
  } catch {
    continue;
  }
  for (const imp of parse_imports(rel, text)) if (imp.source) queries.push([rel, imp.source]);
}

const ts = await Promise.all(queries.map(([f, s]) => _resolve(repo, f, s)));
const rust = addon.resolveBatch(repo, queries);

let ok = 0;
let bad = 0;
const diffs: string[] = [];
for (let i = 0; i < queries.length; i++) {
  const t = ts[i] ?? null;
  const r = rust[i] ?? null;
  if (t === r) ok++;
  else {
    bad++;
    if (diffs.length < 12) diffs.push(`  [${queries[i][0]}] "${queries[i][1]}"\n    ts:   ${t}\n    rust: ${r}`);
  }
}
console.log(`TS resolve parity: ${queries.length} queries over ${Math.min(files.length, maxFiles)} files`);
console.log(`  ✅ identical: ${ok}\n  ❌ mismatch:  ${bad}`);
if (bad) {
  console.log(diffs.join("\n"));
  process.exit(1);
}
console.log("→ byte-identical TS module resolution");
