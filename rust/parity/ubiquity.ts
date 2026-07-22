// Byte-identical harness (G2) — Rust ubiquity (reverse-import fan-in + sample consumers) vs TS ubiquityIndex /
// ubiquityConsumers over the whole repo.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { ubiquityIndex, ubiquityConsumers } from "../../ts/src/codebase/grow/ubiquity.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const sampleN = parseInt(process.argv[3] ?? "40", 10);

// FAN-IN MAP
const tsMap: Map<string, number> = await ubiquityIndex(repo);
const rustList = addon.ubiquityIndex(repo) as { file: string; count: number }[];
const tsLines = [...tsMap.entries()].map(([f, c]) => `${f} ${c}`).sort();
const rustLines = rustList.map((x) => `${x.file} ${x.count}`).sort();
let idxOk = tsLines.length === rustLines.length && tsLines.every((l, i) => l === rustLines[i]);
if (!idxOk) {
  const k = tsLines.findIndex((l, i) => l !== rustLines[i]);
  console.log(`✗ fan-in map differs (ts ${tsLines.length} / rust ${rustLines.length})\n  ts:   ${tsLines[k] ?? "<none>"}\n  rust: ${rustLines[k] ?? "<none>"}`);
}

// SAMPLE CONSUMERS — top-fan-in files (the interesting ones) + some low-fan.
const ranked = [...tsMap.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
const sample = [...ranked.slice(0, sampleN), ...ranked.slice(-sampleN)];
let cOk = 0, cBad = 0; const fails: string[] = [];
for (const f of sample) {
  const ts = (await ubiquityConsumers(repo, f)).join(",");
  const rust = (addon.ubiquityConsumers(repo, f, 3) as string[]).join(",");
  if (ts === rust) cOk++; else { cBad++; if (fails.length < 8) fails.push(`✗ ${f}\n  ts:   ${ts}\n  rust: ${rust}`); }
}
console.log(`\nubiquity parity: fan-in map ${idxOk ? "OK" : "MISMATCH"} (${tsLines.length} files); consumers ${cOk} ok / ${cBad} bad (sample ${sample.length})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(!idxOk || cBad ? 1 : 0);
