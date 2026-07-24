// _prompt parity (Phase 5) — Rust discover_prompt vs TS key_matcher._prompt. _prompt is module-private, so the
// TS side is reconstructed by evaluating the exact template body from the source with the same blocks/retry.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

const src = readFileSync("/home/scorbutics/seam-phase0/ts/src/codebase/coupling/key_matcher.ts", "utf8").split("\n");
const body = src.slice(38, 129).join("\n").replace(/^\s*return `/, ""); // template text (lines 39..129), strip prefix

function tsPrompt(files: { file: string; snippet: string }[], deadTokens: string[]): string {
  const blocks = files.map((f) => `=== FILE: ${f.file} ===\n${f.snippet}`).join("\n\n");
  const retry = deadTokens.length
    ? `\nA PREVIOUS attempt proposed rules whose token matched NOTHING literally in these files: ` +
      `${deadTokens.join(", ")}. Either correct the token/argIndex to a call that LITERALLY appears above, or omit it.\n`
    : "";
  return eval("`" + body + "`");
}

const cases: { files: [string, string][]; dead: string[] }[] = [
  { files: [], dead: [] },
  { files: [["a/b.ts", "const x = 1;\nbus.publish('sync');\n"]], dead: [] },
  { files: [["a/b.ts", "prisma.user.findMany()"], ["c/d.java", "@JmsListener(destination=\"q\")\nvoid x(){}"]], dead: ["publish", "$emit"] },
  { files: [["x.vue", "<div @sync=\"f()\">"]], dead: ["ng-"] },
];

let bad = 0;
for (const c of cases) {
  const ts = tsPrompt(c.files.map(([file, snippet]) => ({ file, snippet })), c.dead);
  const rust = addon.discoverPrompt(JSON.stringify(c.files), JSON.stringify(c.dead));
  if (ts !== rust) {
    bad++;
    let i = 0;
    while (i < Math.min(ts.length, rust.length) && ts[i] === rust[i]) i++;
    console.log(`  DIFF (files=${c.files.length} dead=${c.dead.length}) at byte ${i}: TS=${ts.length}B Rust=${rust.length}B`);
    console.log("    TS  …", JSON.stringify(ts.slice(Math.max(0, i - 25), i + 30)));
    console.log("    Rust…", JSON.stringify(rust.slice(Math.max(0, i - 25), i + 30)));
  }
}
console.log(`_prompt parity: ${cases.length - bad} ok / ${bad} bad`);
process.exit(bad ? 1 : 0);
