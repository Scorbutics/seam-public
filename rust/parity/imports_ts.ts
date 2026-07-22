// PHASE 1 byte-identical harness — Rust `tsImports` vs TS `parse_imports` for .ts/.js files (reexport in key).
//   bun rust/parity/imports_ts.ts <file.ts> [...]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse_imports } from "../../ts/src/core/resolve/languages/index.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const key = (r: any) => `${r.name}${r.local}${r.line}${r.col}${r.source}${r.reexport ? 1 : 0}`;
const dump = (refs: any[]) => refs.map(key).join("\n");

const files = process.argv.slice(2);
let ok = 0;
let bad = 0;
const fails: string[] = [];
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  const ts = dump(parse_imports(file, text));
  const rust = dump(addon.tsImports(text));
  if (ts === rust) ok++;
  else {
    bad++;
    if (fails.length < 6) {
      const tl = ts.split("\n");
      const rl = rust.split("\n");
      let first = "(count)";
      for (let i = 0; i < Math.max(tl.length, rl.length); i++)
        if (tl[i] !== rl[i]) {
          first = `    ts:   ${tl[i] ?? "∅"}\n    rust: ${rl[i] ?? "∅"}`;
          break;
        }
      fails.push(`  ${file}  (ts=${tl.length} rust=${rl.length})\n${first}`);
    }
  }
}
console.log(`ts imports parity over ${ok + bad} files:\n  ✅ identical: ${ok}\n  ❌ mismatch:  ${bad}`);
if (bad) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("→ byte-identical TS/JS import scan");
