// PHASE 1 byte-identical harness — Rust CallsiteIndex.subclass_family vs TS _subclass_family, over the Java
// bases index. Both build the bases map over the SAME walk-ordered java files (from Rust's sourceFiles), so
// last-write-wins on a duplicate class name is apples-to-apples; then compare families for every class.
//   bun rust/parity/family.ts [repo]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { makeCtx, available } from "../../ts/src/codebase/atoms.js";
import { _class_bases, _subclass_family } from "../../ts/src/codebase/scan/ast_class.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
if (!available()) {
  console.log("tree-sitter unavailable — skipped");
  process.exit(0);
}

// walk-ordered java files (from Rust) → build the TS bases map in the same order (last write wins)
const files: string[] = addon.sourceFiles(repo, ".java");
const bases = new Map<string, string[]>();
for (const rel of files) {
  let text: string;
  try {
    text = readFileSync(`${repo}/${rel}`, "utf-8");
  } catch {
    continue;
  }
  const ctx = await makeCtx(text, "java");
  if (!ctx) continue;
  for (const [cls, bs] of _class_bases(ctx) as [string, string[]][]) bases.set(cls, bs);
}

// every class that IS extended by something is an interesting owner; also sample bare class names.
const owners = [...bases.keys()];
const rustFams: string[][] = addon.subclassFamilyBatch(repo, owners);

let ok = 0;
let bad = 0;
let nonTrivial = 0;
const fails: string[] = [];
for (let i = 0; i < owners.length; i++) {
  const ts = [..._subclass_family(bases, owners[i])].sort();
  const rust = rustFams[i];
  if (ts.length > 1) nonTrivial++;
  if (ts.join("\n") === rust.join("\n")) ok++;
  else {
    bad++;
    if (fails.length < 8) fails.push(`  ${owners[i]}\n    ts:   ${ts.slice(0, 12).join(", ")}\n    rust: ${rust.slice(0, 12).join(", ")}`);
  }
}
console.log(`subclass_family parity over ${owners.length} owners (${nonTrivial} with subclasses):`);
console.log(`  ✅ identical: ${ok}\n  ❌ mismatch:  ${bad}`);
if (bad) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("→ byte-identical subclass families");
