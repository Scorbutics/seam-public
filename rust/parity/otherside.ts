// Byte-identical harness — Rust other_side vs TS otherSide, over EVERY key in the Keycloak floor index, both
// directions (produces true/false). Exercises the http-route suffix-specificity scoring (the subtle path).
import { createRequire } from "node:module";
import { floor_base_index, otherSide } from "../../ts/src/codebase/coupling/index.js";
import { SKIP_DIRS } from "../../ts/src/core/resolve/languages/index.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";

const ctx = new EngineCtx();
const idx = floor_base_index(repo, SKIP_DIRS, ctx);
const ser = (accs: any[]) => accs.map((a) => `${a.file}|${a.line}`).join(";");
const serR = (rows: string[][]) => rows.map((r) => r.join("|")).join(";");

let ok = 0, bad = 0, checked = 0;
const fails: string[] = [];
for (const key of idx.keys()) {
  const sp = key.indexOf(" ");
  const kind = key.slice(0, sp);
  const value = key.slice(sp + 1);
  for (const produces of [true, false]) {
    checked++;
    const ts = ser(otherSide(idx, kind, value, produces));
    const rust = serR(addon.otherSide(repo, kind, value, produces) as string[][]);
    if (ts === rust) ok++;
    else { bad++; if (fails.length < 15) fails.push(`✗ [${kind} ${value}] produces=${produces}\n    ts:   ${ts}\n    rust: ${rust}`); }
  }
}
console.log(`\nother_side parity over ${repo}  (${checked} lookups, ${idx.size} keys)`);
console.log(`  ${ok} ok / ${bad} bad`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
