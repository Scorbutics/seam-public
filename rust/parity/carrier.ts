// BYTE-IDENTICAL harness — the Rust carrier axis vs the TypeScript oracle it replaces. Compares the
// repo-wide `carrierChannelIndex` (every key, every producer/consumer access, in index order) and the
// per-anchor `anchorCarrierAccs` for EVERY Ruby method def in the repo, so the trace, the teacher-2 key
// recovery and the glob grounding are all pinned — not just the one fixture the unit tests use.
//
//   bun rust/parity/carrier.ts [repo…]      (default: the two checked-in Ruby fixtures)
//
// The TS side dies with `ts/src/codebase/coupling/` — this harness is the evidence gate that has to run
// GREEN before that deletion, and it is expected to be deleted along with its oracle.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { carrierChannelIndex, anchorCarrierAccs } from "../../ts/src/codebase/coupling/carrier/engine.js";
import { walkFiles } from "../../ts/src/core/resolve/walk.js";
import { SKIP_DIRS } from "../../ts/src/core/resolve/languages/base.js";

const require = createRequire(import.meta.url);
const addon = require(join(dirname(fileURLToPath(import.meta.url)), "..", "seam_core.node"));

const HERE = dirname(fileURLToPath(import.meta.url));
const repos = process.argv.slice(2);
if (!repos.length) repos.push(join(HERE, "..", "..", "ts", "eval", "coupling-fixtures", "psdk-mini"));

// Both sides flattened to the SAME row shape, so a diff points at one access, not one blob.
const tsIndexRows = (idx: Map<string, { producers: { file: string; line: number }[]; consumers: { file: string; line: number }[] }>): string[] => {
  const rows: string[] = [];
  for (const [key, sides] of idx) {
    for (const a of sides.producers) rows.push(`${key}|p|${a.file}|${a.line}`);
    for (const a of sides.consumers) rows.push(`${key}|c|${a.file}|${a.line}`);
  }
  return rows;
};
const rsRows = (rows: string[][]): string[] => rows.map((r) => r.join("|"));

let checked = 0;
let bad = 0;
const fail = (what: string, ts: string[], rs: string[]) => {
  bad++;
  console.log(`\n❌ ${what}`);
  const n = Math.max(ts.length, rs.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 12; i++) {
    if (ts[i] !== rs[i]) {
      console.log(`   [${i}] ts: ${ts[i] ?? "—"}`);
      console.log(`        rs: ${rs[i] ?? "—"}`);
      shown++;
    }
  }
  if (ts.length !== rs.length) console.log(`   (lengths: ts=${ts.length} rs=${rs.length})`);
};

for (const repo of repos) {
  // 1 — the repo-wide channel index.
  const ts = tsIndexRows(await carrierChannelIndex(repo));
  const rs = rsRows(addon.carrierChannelIndex(repo));
  checked++;
  if (ts.join("\n") !== rs.join("\n")) fail(`${repo} :: carrierChannelIndex`, ts, rs);

  // 2 — the per-anchor accesses, over the WHOLE file (lo=0, hi=∞) for every Ruby file. A file-wide span is
  // the strongest form: it exercises every call site in the file at once, and a line-window bug would show
  // up as a row present on one side only.
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, (r) => r.endsWith(".rb") || r.endsWith(".rake"))) {
    const a = (await anchorCarrierAccs(repo, rel, text, 0, 1e9)).map((h) => `${h.kind}|${h.value}|${h.produces}|${h.line}`);
    const b = rsRows(addon.anchorCarrierAccs(repo, rel, text, 0, 1_000_000_000));
    checked++;
    if (a.join("\n") !== b.join("\n")) fail(`${repo} :: anchorCarrierAccs ${rel}`, a, b);
  }
}

console.log(`\n${bad === 0 ? "✅" : "❌"} carrier parity: ${checked - bad}/${checked} identical`);
process.exit(bad === 0 ? 0 : 1);
