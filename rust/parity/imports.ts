// PHASE 1 byte-identical harness — Rust `javaImports` vs TS `parse_imports` over a batch of files.
// The import scan is the foundation the reverse-import index (→ `consumers`) is built from, so this pins
// the first ported primitive before anything is built on it.
//
//   bun rust/parity/imports.ts <file.java> [file2.java ...]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse_imports } from "../../ts/src/core/resolve/languages/index.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

// Field-explicit key (robust to object-key ordering across the napi/JS boundary).
const key = (r: any) => `${r.name}${r.local}${r.line}${r.col}${r.source}`;
const dump = (refs: any[]) => refs.map(key).join("\n");

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: bun rust/parity/imports.ts <file.java> [...]");
  process.exit(2);
}

let ok = 0;
let mismatch = 0;
const failures: string[] = [];

for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  const ts = dump(parse_imports(file, text));
  const rust = dump(addon.javaImports(text));
  if (ts === rust) {
    ok++;
  } else {
    mismatch++;
    if (failures.length < 5) {
      const tl = ts.split("\n");
      const rl = rust.split("\n");
      const n = Math.max(tl.length, rl.length);
      let firstLine = "(count differs)";
      for (let i = 0; i < n; i++) {
        if (tl[i] !== rl[i]) {
          firstLine = `    ts:   ${tl[i] ?? "∅"}\n    rust: ${rl[i] ?? "∅"}`;
          break;
        }
      }
      failures.push(`  ${file}\n    ts refs=${tl.length} rust refs=${rl.length}\n${firstLine}`);
    }
  }
}

console.log(`imports parity over ${ok + mismatch} java files:`);
console.log(`  ✅ identical: ${ok}`);
console.log(`  ❌ mismatch:  ${mismatch}`);
if (mismatch) {
  console.log(failures.join("\n"));
  process.exit(1);
}
console.log("→ byte-identical import scan across the corpus");
