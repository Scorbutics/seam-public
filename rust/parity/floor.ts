// Byte-identical harness — Rust floor_index (the GROUND stage: floorBase = mergeGrounding(shared, param),
// jpa-wrapper folded in) vs TS floor_base_index, over a whole repo. Compares the flattened per-access rows in
// index insertion order (producers before consumers per key).
import { createRequire } from "node:module";
import { floor_base_index } from "../../ts/src/codebase/coupling/index.js";
import { SKIP_DIRS } from "../../ts/src/core/resolve/languages/index.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";

// TS floor rows, same shape as the Rust napi export: [key, side, file, line].
const ctx = new EngineCtx();
const idx = floor_base_index(repo, SKIP_DIRS, ctx);
const tsRows: string[] = [];
for (const [key, sides] of idx) {
  for (const a of sides.producers) tsRows.push(`${key}|p|${a.file}|${a.line}`);
  for (const a of sides.consumers) tsRows.push(`${key}|c|${a.file}|${a.line}`);
}

const rustRows = (addon.floorIndex(repo) as string[][]).map((r) => r.join("|"));

console.log(`\nfloor_base_index parity over ${repo}`);
console.log(`  ts rows: ${tsRows.length}   rust rows: ${rustRows.length}   distinct keys: ${idx.size}`);

let bad = 0;
const n = Math.max(tsRows.length, rustRows.length);
const fails: string[] = [];
for (let i = 0; i < n; i++) {
  if (tsRows[i] !== rustRows[i]) {
    bad++;
    if (fails.length < 20) fails.push(`  [${i}]\n    ts:   ${tsRows[i] ?? "<none>"}\n    rust: ${rustRows[i] ?? "<none>"}`);
  }
}
console.log(bad ? `\n  MISMATCH: ${bad} differing rows` : `\n  byte-identical ✓  (${tsRows.length} rows)`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
