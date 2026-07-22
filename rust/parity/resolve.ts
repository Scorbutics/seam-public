// PHASE 1 byte-identical harness — Rust java floor_resolve vs TS floor_resolve. Generates realistic queries:
// every real import's FQN (paired with its file) + each file's own bare class name (the same-package path) +
// sibling bare names (the flat-package case). Both sides build the FQN index from the SAME git file set.
//
//   bun rust/parity/resolve.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { parse_imports } from "../../ts/src/core/resolve/languages/index.js";
import { floor_resolve } from "../../ts/src/languages/java/resolve.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "1500", 10);

// the git file set (same source of truth the index uses)
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString()
  .split("\0")
  .filter(Boolean);

const classOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1, -5);
// group by dir → cheap sibling source for the flat-package bare-name path
const byDir = new Map<string, string[]>();
for (const f of files) {
  const d = f.slice(0, f.lastIndexOf("/"));
  (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f);
}

const queries: [string, string][] = [];
const sample = files.slice(0, maxFiles);
for (const rel of sample) {
  let text: string;
  try {
    text = readFileSync(`${repo}/${rel}`, "utf-8");
  } catch {
    continue;
  }
  for (const imp of parse_imports(rel, text)) if (imp.source) queries.push([rel, imp.source]); // FQN path
  queries.push([rel, classOf(rel)]); // bare name → itself (same-package path)
  const sibs = byDir.get(rel.slice(0, rel.lastIndexOf("/"))) ?? [];
  for (const s of sibs.slice(0, 3)) if (s !== rel) queries.push([rel, classOf(s)]); // sibling bare names
}

// TS reference (floor_resolve caches its index after the first call)
const ts = queries.map(([f, s]) => floor_resolve(repo, f, s));
// Rust batch (builds the index once)
const rust = addon.javaResolveBatch(repo, queries);

let ok = 0;
let bad = 0;
const diffs: string[] = [];
for (let i = 0; i < queries.length; i++) {
  const t = ts[i] ?? null;
  const r = rust[i] ?? null;
  if (t === r) ok++;
  else {
    bad++;
    if (diffs.length < 10) diffs.push(`  [${queries[i][0]}] source="${queries[i][1]}"\n    ts:   ${t}\n    rust: ${r}`);
  }
}

console.log(`floor_resolve parity: ${queries.length} queries over ${sample.length} files (${byDir.size} packages)`);
console.log(`  ✅ identical: ${ok}`);
console.log(`  ❌ mismatch:  ${bad}`);
if (bad) {
  console.log(diffs.join("\n"));
  process.exit(1);
}
console.log("→ byte-identical FQN index + floor_resolve");
