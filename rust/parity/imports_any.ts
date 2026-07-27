// PHASE 1 byte-identical harness — Rust import parser vs TS `parse_imports`, dispatched by extension.
// One harness for every language: .java → javaImports, .ts/.js/… → tsImports, .rb/.rake → rubyImports.
//   bun rust/parity/imports_any.ts <file> [...]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse_imports } from "../../ts/src/core/resolve/languages/index.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

// Every extension a provider now OWNS. `.py`/`.pyi` joined when the python provider was ported; the minimal
// providers (kotlin/c/cpp) own their extensions too and must parse to NO imports on both engines — that
// "reads nothing" agreement is worth pinning, because a provider that silently started inventing imports
// would look like recall rather than the regression it is.
const SRC_EXT = [".java", ".rb", ".rake", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
  ".py", ".pyi", ".kt", ".kts", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"];
const isSrc = (f: string) => SRC_EXT.some((e) => f.toLowerCase().endsWith(e));
// `source ?? null` — TS emits `null` for "no resolvable module", napi maps Rust's `None` to `undefined`. Same
// meaning, same truthiness at every consumer; only this harness's string interpolation could tell them apart,
// and reporting that as a divergence would be reporting the harness.
const key = (r: any) => `${r.name}${r.local}${r.line}${r.col}${r.source ?? null}${r.reexport ? 1 : 0}`;
const dump = (refs: any[]) => refs.map(key).join("\n");

let ok = 0;
let bad = 0;
let skip = 0;
const fails: string[] = [];
for (const file of process.argv.slice(2)) {
  if (!isSrc(file)) {
    skip++;
    continue;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  const ts = dump(parse_imports(file, text));
  const rust = dump(addon.importsOf(file, text));
  if (ts === rust) ok++;
  else {
    bad++;
    if (fails.length < 8) {
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
console.log(`import parity: ✅ ${ok}  ❌ ${bad}  (skipped ${skip} non-source)`);
if (bad) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("→ byte-identical");
