// PHASE 1 byte-identical harness — the tree-sitter AST scans the callsite index is built from.
// Rust called_methods / class_bases vs TS _called_method_names / _class_bases, over Java files.
//   bun rust/parity/ast.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeCtx, available } from "../../ts/src/codebase/atoms.js";
import { _called_method_names, _class_bases } from "../../ts/src/codebase/scan/ast_class.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "2000", 10);

if (!available()) {
  console.log("tree-sitter unavailable — skipped");
  process.exit(0);
}

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString()
  .split("\0")
  .filter(Boolean)
  .slice(0, maxFiles);

const basesKey = (b: any) => `${b.name}<${b.bases.join(",")}>`;

let callsOk = 0;
let callsBad = 0;
let basesOk = 0;
let basesBad = 0;
const fails: string[] = [];
for (const rel of files) {
  let text: string;
  try {
    text = readFileSync(`${repo}/${rel}`, "utf-8");
  } catch {
    continue;
  }
  const ctx = await makeCtx(text, "java");
  if (!ctx) continue;

  const tsCalls = _called_method_names(ctx).join("\n");
  const rustCalls = (addon.calledMethods(text, "java") as string[]).join("\n");
  if (tsCalls === rustCalls) callsOk++;
  else {
    callsBad++;
    if (fails.length < 6) fails.push(`  calls ${rel}\n    ts:   ${tsCalls.slice(0, 200)}\n    rust: ${rustCalls.slice(0, 200)}`);
  }

  const tsBases = (_class_bases(ctx) as [string, string[]][]).map(([name, bases]) => `${name}<${bases.join(",")}>`).join("\n");
  const rustBases = (addon.classBases(text, "java") as any[]).map(basesKey).join("\n");
  if (tsBases === rustBases) basesOk++;
  else {
    basesBad++;
    if (fails.length < 6) fails.push(`  bases ${rel}\n    ts:   ${tsBases.slice(0, 200)}\n    rust: ${rustBases.slice(0, 200)}`);
  }
}
console.log(`AST scan parity over ${callsOk + callsBad} java files:`);
console.log(`  called_method_names: ✅ ${callsOk}  ❌ ${callsBad}`);
console.log(`  class_bases:         ✅ ${basesOk}  ❌ ${basesBad}`);
if (callsBad || basesBad) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("→ byte-identical AST scans");
