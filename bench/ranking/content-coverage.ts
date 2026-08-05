// CONTENT COVERAGE @ DEMAND — of the files an agent actually OPENS, how many does the map ship CODE for?
//
// `bun bench/ranking/content-coverage.ts <case-prefix> [--arm A|B]`
//
// THE METRIC THAT PREDICTS THE THING WE CARE ABOUT. `rank-eval.ts` scores ORDER and `render-head.ts` scores
// which files the render surfaces, but neither predicts a saved tool call: an agent re-opens a file when the
// citation has nothing to dereference, so a file that is surfaced WITHOUT its code still costs the read. This
// scores the only thing that removes one — cited AND shown — weighted by how often the file is really opened.
//
// THREE NUMBERS, KEPT APART, because they fail differently and have different cures:
//   cited    the map named the file at all           → a gap here is RECALL (the engine did not reach it)
//   coded    the map named it AND printed its lines  → a gap here is CONTENT (the render rationed the text)
//   the gap between them is the CONTENT gap, and it is the one the snippet budget controls.
//
// WEIGHTED BY OPENS, not by distinct files: a file the agent opened 127 times and one it opened once are not
// equally worth showing, and an unweighted count lets a long tail of one-off reads outvote the hot files the
// whole format exists to save.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { demand, TS } from "./lib.ts";

const argv = process.argv.slice(2);
const ARM = (argv[argv.indexOf("--arm") + 1] === "B" ? "B" : "A") as "A" | "B";
const prefix = argv.find((a) => !a.startsWith("--") && a !== "A" && a !== "B") ?? "kc";
const mapPath = argv[argv.indexOf("--map") + 1];

if (!mapPath || mapPath.startsWith("--")) {
  console.error("usage: content-coverage.ts <case-prefix> --map <rendered-agent-map.txt> [--arm A|B]");
  console.error("  the map is a saved `--format agent` render of the case's own grow (this does not re-run it,");
  console.error("  so the render under test is exactly the one you are looking at).");
  process.exit(2);
}
const out = readFileSync(mapPath, "utf-8");

// A citation is `path:line` OUTSIDE a gutter line; a gutter line (`  123│` / `  123>`) is the code itself and
// belongs to the citation above it. Parsed the same way `verification-tax.ts` and `render-head.ts` do.
const isGutter = (l: string) => /^\s+\d+[│>]/.test(l);
const cited = new Set<string>();
const coded = new Set<string>();
let cur: string | null = null;
for (const line of out.split("\n")) {
  // EVERY citation on the line, not the first. A line can carry several — the header names all pinned
  // centers, a spine step names caller and callee — and `match()` returned only the leftmost, so the second
  // file on any such line read as uncited. Measured: `RealmsAdminResource.java`, the most-opened file in the
  // corpus, is cited in the header after `realms.ts` and was scored missing because of it.
  if (!isGutter(line)) {
    let first: string | null = null;
    for (const m of line.matchAll(/([\w./@-]+\.\w{1,5}):(\d+)/g)) { first ??= m[1]; cited.add(m[1]); }
    // ATTRIBUTION IS THE FIRST citation, CITATION is all of them. A snippet is emitted by `seamLine` from the
    // seam's OWN primary, which leads the line; the trailing prose ("reached from X (f:l)") cites others that
    // get no code. Crediting the last one moved `coded` from 62.2% to 46.9% by attributing every snippet to
    // whatever the prose happened to mention.
    if (first) cur = first;
  }
  if (isGutter(line) && cur) coded.add(cur);
}
if (!cited.size) { console.error(`ABORT: parsed 0 citations from ${mapPath} — the extractor or the map is broken.`); process.exit(3); }

const opens = new Map<string, number>();
for (const c of demand.filter((c) => c.case.startsWith(prefix) && c.arm === ARM))
  for (const f of [...c.reads, ...c.bashReads]) opens.set(f, (opens.get(f) ?? 0) + 1);
if (!opens.size) { console.error(`ABORT: no arm-${ARM} demand for prefix '${prefix}'.`); process.exit(3); }

const total = [...opens.values()].reduce((a, b) => a + b, 0);
const weigh = (s: Set<string>) => [...opens].filter(([f]) => s.has(f)).reduce((n, [, c]) => n + c, 0);
const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

console.log(`\n══════ CONTENT COVERAGE @ DEMAND — arm ${ARM}, prefix '${prefix}'`);
console.log(`   ${total} open(s) over ${opens.size} distinct file(s); the map cites ${cited.size} file(s), ships code for ${coded.size}\n`);
console.log(`   cited  ${pct(weigh(cited)).padStart(6)}   ← a gap here is the engine's RECALL`);
console.log(`   coded  ${pct(weigh(coded)).padStart(6)}   ← a gap here is the render's CONTENT budget  (THE METRIC)`);
console.log(`\n   the most-opened files:`);
for (const [f, n] of [...opens].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`   ${String(n).padStart(4)} opens  ${coded.has(f) ? "CODE" : cited.has(f) ? "cite" : "  — "}  ${f}`);
console.log(`\n   "cite" = named but not shown: the agent still pays the read. "—" = never named at all.\n`);
