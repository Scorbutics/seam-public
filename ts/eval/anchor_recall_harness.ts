#!/usr/bin/env bun
// ANCHOR-RECALL validation — the graduation gate for `--anchor-recall embed`. Measures the FINAL chosen
// anchor (recall → probe → LLM judge) vs human ground truth, `embed` vs `lexical`, on a labeled corpus.
// Flip the default only when all three hold: (1) embed aggregate accuracy ≥ 80% (ideal 90%); (2) NO
// per-case regression (embed ≥ lexical everywhere — guards the real risk: a bigger pool luring the judge
// to an embed distractor); (3) a strict win on the fuzzy subset (where lexical < 80%).
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

async function runMode(c: Case, mode: "lexical" | "embed", i: number, force: boolean): Promise<string | null> {
  const dest = join(RUNS_DIR, mode, c.label, `run_${i}.json`);
  if (existsSync(dest) && !force) return JSON.parse(readFileSync(dest, "utf-8")).chosen;
  const sel = await select_anchor(expandHome(c.repo), c.intent, { anchorRecall: mode, dataCoupling: true });
  const chosen = sel.chosen ? `${sel.chosen.name}@${sel.chosen.file}` : null;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify({ chosen, chosenBy: sel.chosenBy }));
  return chosen;
}

const hit = (chosen: string | null, expected: string) => !!chosen && chosen.toLowerCase().includes(expected.toLowerCase());

async function main(argv: string[]): Promise<number> {
  let runs = 3, only: string | undefined, force = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--runs") runs = parseInt(argv[++i], 10);
    else if (v === "--case") only = argv[++i];
    else if (v === "--force") force = true;
  }
  let cases: Case[] = JSON.parse(readFileSync(CASES, "utf-8"));
  if (only) cases = cases.filter((c) => c.label === only);

  const acc: Record<string, Record<string, number>> = {};   // case → mode → accuracy
  for (const c of cases) {
    acc[c.label] = {};
    for (const mode of MODES) {
      const chosens: (string | null)[] = [];
      for (let i = 1; i <= runs; i++) { process.stderr.write(`[${mode}] ${c.label} ${i}/${runs}\n`); chosens.push(await runMode(c, mode, i, force)); }
      acc[c.label][mode] = chosens.filter((ch) => hit(ch, c.expectedAnchor)).length / chosens.length;
    }
  }

  // report + 3-condition gate
  process.stdout.write(`\n=== anchor recall: embed vs lexical (${runs} runs/case, bar ${pct(ACC_FLOOR)}/${pct(ACC_TARGET)}) ===\n`);
  let regress: string[] = [], fuzzyWin = 0, fuzzyN = 0;
  const agg = { lexical: 0, embed: 0 };
  for (const c of cases) {
    const l = acc[c.label].lexical, e = acc[c.label].embed;
    agg.lexical += l; agg.embed += e;
    const tag = c.lexicalMiss ? " [fuzzy]" : "";
    process.stdout.write(`  ${c.label.padEnd(22)}${tag.padEnd(8)} lexical ${pct(l)}  →  embed ${pct(e)} ${grade(e)}${e < l ? "   ⚠ REGRESSION" : ""}\n`);
    if (e < l - 1e-9) regress.push(`${c.label}: embed ${pct(e)} < lexical ${pct(l)}`);
    if (c.lexicalMiss) { fuzzyN++; if (e > l + 1e-9) fuzzyWin++; }
  }
  const n = cases.length;
  const aggE = agg.embed / n, aggL = agg.lexical / n;
  process.stdout.write(`\n  aggregate:  lexical ${pct(aggL)}  →  embed ${pct(aggE)}\n`);

  const cond1 = aggE >= ACC_FLOOR;
  const cond2 = regress.length === 0;
  const cond3 = fuzzyN === 0 || fuzzyWin > 0;
  process.stdout.write(`\n  (1) embed aggregate ≥ ${pct(ACC_FLOOR)}:        ${cond1 ? "✅" : "❌"} (${pct(aggE)})\n`);
  process.stdout.write(`  (2) no per-case regression:        ${cond2 ? "✅" : "❌ " + regress.join("; ")}\n`);
  process.stdout.write(`  (3) strict win on fuzzy subset:    ${cond3 ? "✅" : "❌"} (${fuzzyWin}/${fuzzyN} fuzzy cases improved)\n`);
  const pass = cond1 && cond2 && cond3;
  process.stdout.write(`\n  ${pass ? "✅ GRADUATE: flip --anchor-recall embed to default" : "❌ NOT YET — keep embed opt-in"}\n`);
  return pass ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
