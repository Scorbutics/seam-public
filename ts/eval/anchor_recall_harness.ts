#!/usr/bin/env bun
// ANCHOR-RECALL validation — the graduation gate for `--anchor-recall embed`. Measures the FINAL chosen
// anchor (recall → probe → LLM judge) vs human ground truth, `embed` vs `lexical`, on a labeled corpus.
// Flip the default only when all three hold: (1) embed aggregate accuracy ≥ 80% (ideal 90%); (2) NO
// per-case regression (embed ≥ lexical everywhere — guards the real risk: a bigger pool luring the judge
// to an embed distractor); (3) a strict win on the fuzzy subset (where lexical < 80%).
//
// GATE RESULT (2026-06): embed GRADUATED — 83% vs lexical 50%, no per-case regression, fuzzy wins
// (scorer-match/inbound-load 0→100; matching-engine 0→0 is the known vocabulary gap). `embed` is now
// the engine/CLI default.
//
// ⚠ WASM-HEAP CAVEAT: embed uses tree-sitter + transformers WASM; running ALL cases in ONE process
// (the no-`--case` batch below) exhausts the WASM heap after ~dozens of in-process select_anchor calls
// and prints `Aborted()` — embed runs then return null and score a FALSE 0%. The PRODUCT is unaffected
// (one select_anchor per process). For clean embed numbers run PER-CASE (each a fresh process):
//   for c in <labels>; do bun ts/eval/anchor_recall_harness.ts --runs 3 --case "$c"; done
//
//   bun ts/eval/anchor_recall_harness.ts --runs 3            # run+score both modes, cached
//   bun ts/eval/anchor_recall_harness.ts --runs 3 --case scorer-match
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { select_anchor } from "../src/codebase/anchor_select.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CASES = join(__dir, "anchor-cases.json");
const RUNS_DIR = join(__dir, "_anchor_runs");
type Case = { label: string; repo: string; intent: string; expectedAnchor: string; lexicalMiss?: boolean };
const expandHome = (p: string) => p.startsWith("~") ? join(process.env.HOME ?? "", p.slice(1)) : p;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const ACC_FLOOR = 0.8, ACC_TARGET = 0.9;
const grade = (x: number) => x < ACC_FLOOR ? "❌FAIL" : x < ACC_TARGET ? "⚠ WARN" : "✅PASS";
const MODES = ["lexical", "embed"] as const;

// modes: "lexical" (name-filter floor) | "embed" (semantic recall union); selection is always probe→judge.
async function runMode(c: Case, mode: string, i: number, force: boolean): Promise<string | null> {
  const dest = join(RUNS_DIR, mode, c.label, `run_${i}.json`);
  if (existsSync(dest) && !force) return JSON.parse(readFileSync(dest, "utf-8")).chosen;
  const recall = mode.startsWith("embed") ? "embed" : "lexical";
  const sel = await select_anchor(expandHome(c.repo), c.intent, { anchorRecall: recall, dataCoupling: true });
  const chosen = sel.chosen ? `${sel.chosen.name}@${sel.chosen.file}` : null;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify({ chosen, chosenBy: sel.chosenBy, noFlow: sel.noFlow ?? false }));
  return chosen;
}

const hit = (chosen: string | null, expected: string) => !!chosen && chosen.toLowerCase().includes(expected.toLowerCase());

async function main(argv: string[]): Promise<number> {
  let runs = 3, only: string | undefined, force = false, modes: string[] = [...MODES];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--runs") runs = parseInt(argv[++i], 10);
    else if (v === "--case") only = argv[++i];
    else if (v === "--force") force = true;
    else if (v === "--modes") modes = argv[++i].split(",").map((m) => m.trim());
  }
  let cases: Case[] = JSON.parse(readFileSync(CASES, "utf-8"));
  if (only) cases = cases.filter((c) => c.label === only);

  const acc: Record<string, Record<string, number>> = {};   // case → mode → accuracy
  for (const c of cases) {
    acc[c.label] = {};
    for (const mode of modes) {
      const chosens: (string | null)[] = [];
      for (let i = 1; i <= runs; i++) { process.stderr.write(`[${mode}] ${c.label} ${i}/${runs}\n`); chosens.push(await runMode(c, mode, i, force)); }
      acc[c.label][mode] = chosens.filter((ch) => hit(ch, c.expectedAnchor)).length / chosens.length;
    }
  }

  // per-mode accuracy report (generic over modes; bold the best per case)
  process.stdout.write(`\n=== anchor accuracy by mode (${runs} runs/case, bar ${pct(ACC_FLOOR)}/${pct(ACC_TARGET)}) ===\n`);
  process.stdout.write(`  ${"case".padEnd(22)} ${modes.map((m) => m.padEnd(18)).join("")}\n`);
  const agg: Record<string, number> = Object.fromEntries(modes.map((m) => [m, 0]));
  for (const c of cases) {
    const tag = c.lexicalMiss ? "[fuzzy]" : "";
    const cells = modes.map((m) => `${pct(acc[c.label][m])} ${grade(acc[c.label][m])}`.padEnd(18));
    for (const m of modes) agg[m] += acc[c.label][m];
    process.stdout.write(`  ${(c.label + " " + tag).padEnd(22)} ${cells.join("")}\n`);
  }
  const n = cases.length;
  process.stdout.write(`  ${"AGGREGATE".padEnd(22)} ${modes.map((m) => pct(agg[m] / n).padEnd(18)).join("")}\n`);
  const best = modes.reduce((a, b) => (agg[b] > agg[a] ? b : a), modes[0]);
  process.stdout.write(`\n  best mode: ${best} (${pct(agg[best] / n)})  ${agg[best] / n >= ACC_FLOOR ? "✅ clears the ≥" + pct(ACC_FLOOR) + " bar" : "❌ below the bar"}\n`);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
