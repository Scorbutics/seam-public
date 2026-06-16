#!/usr/bin/env bun
// Auto-grow STABILITY harness — the codebase `--scan --auto --intent` analogue of the diff
// reliability gate (eval/harness.ts). Auto-grow's LLM passes (entrypoint-select / anchor-judge /
// seam-intent) are non-deterministic, so a single run says nothing; what matters is whether the
// MAP IS STABLE across runs — does the same spine, culmination, and tiering come back? This harness
// caches N runs per case and scores run-to-run AGREEMENT (no gold needed — stability is gold-free).
//
//   bun ts/eval/autogrow_harness.ts generate --runs 3 --model claude-haiku-4-5
//   bun ts/eval/autogrow_harness.ts generate --runs 3 --promote-spine-path --label haiku-promote
//   bun ts/eval/autogrow_harness.ts score    --save ts/eval/autogrow-baseline.json
//   bun ts/eval/autogrow_harness.ts score    --baseline ts/eval/autogrow-baseline.json
//
// Seam IDS are NOT stable run-to-run (the grow assigns them positionally), so every metric keys on a
// STABLE IDENTITY: a seam's primary symbol@file (the "this is where it lives" pointer). That is the
// whole point — we measure whether the same CODE lands on the spine / as the culmination, not whether
// an opaque id repeats.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const TS_CLI = join(__dir, "..", "src", "cli", "decompose.ts");
const CASES = join(__dir, "autogrow-cases.json");
const RUNS_DIR = join(__dir, "_autogrow_runs");
const BUN = process.env.HOME ? join(process.env.HOME, ".bun", "bin", "bun") : "bun";

type Case = { label: string; repo: string; intent: string; anchorFile?: string; symbol?: string };
const expandHome = (p: string) => p.startsWith("~") ? join(process.env.HOME ?? "", p.slice(1)) : p;
const mean = (a: number[]): number => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const round = (x: number, n = 3): number => Math.round(x * 10 ** n) / 10 ** n;

function loadCases(only?: string): Case[] {
  if (!existsSync(CASES)) { process.stderr.write(`no cases file: ${CASES}\n`); process.exit(1); }
  let cs: Case[] = JSON.parse(readFileSync(CASES, "utf-8"));
  if (only) cs = cs.filter((c) => c.label === only);
  return cs;
}

// --- a run's STABLE projection ------------------------------------------------------------------
// id-independent identity of a seam = where it lives. Two runs that put the same symbol on the spine
// agree even when the engine numbered the seams differently.
const seamIdentity = (s: any): string => s?.primary ? `${s.primary.symbol}@${s.primary.file}` : (s?.label ?? "?");

type Projection = { spine: string[]; culmination: string | null; tiers: Map<string, string>; nSeams: number };
function project(model: any): Projection {
  const cl = (model.clusters ?? [])[0] ?? { seams: [] };
  const seams: any[] = cl.seams ?? [];
  const byId = new Map(seams.map((s) => [s.id, s]));
  const spine = (cl.spine ?? []).map((id: string) => seamIdentity(byId.get(id))).filter((x: string) => x !== "?");
  // culmination identity: prefer the ranked top, else the selectedSeam pointer.
  const topRanked = (cl.culminationRanked ?? []).filter((r: any) => r.score > 0)[0];
  const culmId = topRanked?.id ?? model.selectedSeam;
  const culmination = culmId ? seamIdentity(byId.get(culmId)) : null;
  const tiers = new Map<string, string>();
  for (const s of seams) tiers.set(seamIdentity(s), s.tier ?? "supporting");
  return { spine, culmination: culmination === "?" ? null : culmination, tiers, nSeams: seams.length };
}

// --- agreement metrics across N projections -----------------------------------------------------
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size && !b.size) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter);
};
function pairwiseMean(items: any[], f: (x: any, y: any) => number): number {
  const vals: number[] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) vals.push(f(items[i], items[j]));
  return vals.length ? mean(vals) : 1;
}
function modeAgreement(xs: (string | null)[]): { value: string | null; fraction: number } {
  const counts = new Map<string, number>();
  for (const x of xs) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | null = null, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return { value: best, fraction: xs.length ? bestN / xs.length : 0 };
}

function stability(projs: Projection[]): any {
  const spineSets = projs.map((p) => new Set(p.spine));
  const culm = modeAgreement(projs.map((p) => p.culmination));
  // tier agreement: over the symbols two runs SHARE, the fraction tiered identically.
  const tierPair = (a: Projection, b: Projection): number => {
    const shared = [...a.tiers.keys()].filter((k) => b.tiers.has(k));
    if (!shared.length) return 1;
    return shared.filter((k) => a.tiers.get(k) === b.tiers.get(k)).length / shared.length;
  };
  const ns = projs.map((p) => p.nSeams), spineLens = projs.map((p) => p.spine.length);
  return {
    runs: projs.length,
    spine_jaccard: round(pairwiseMean(spineSets, jaccard)),
    culmination_agreement: round(culm.fraction),
    culmination_modal: culm.value,
    tier_agreement: round(pairwiseMean(projs, tierPair)),
    spine_len: { min: Math.min(...spineLens), max: Math.max(...spineLens), mean: round(mean(spineLens), 1) },
    seams: { min: Math.min(...ns), max: Math.max(...ns), mean: round(mean(ns), 1) },
  };
}

// --- generate (live LLM via the CLI, claude on PATH) --------------------------------------------
function generate(a: any): number {
  const runs: number = a.runs ?? 3;
  for (const c of loadCases(a.case)) {
    const repo = expandHome(c.repo);
    if (!existsSync(repo)) { process.stdout.write(`[skip] ${c.label}: repo not found (${c.repo})\n`); continue; }
    const label = a.label ?? a.model;
    const outDir = join(RUNS_DIR, label, c.label);
    mkdirSync(outDir, { recursive: true });
    for (let i = 1; i <= runs; i++) {
      const dest = join(outDir, `run_${i}.json`);
      if (existsSync(dest) && !a.force) { process.stdout.write(`[skip] ${c.label} run ${i} (cached)\n`); continue; }
      const args = [TS_CLI, "--scan", "--auto", "--repo", repo, "--intent", c.intent,
        "--classifier", "hybrid", "--model", a.model, "--emit-seams", dest];
      if (c.anchorFile && c.symbol) args.push("--anchor-file", c.anchorFile, "--symbol", c.symbol);
      if (a.promoteSpinePath) args.push("--promote-spine-path");
      process.stdout.write(`[run]  ${c.label} ${i}/${runs} …\n`);
      const proc = spawnSync(BUN, args, { encoding: "utf-8", timeout: 600_000 });
      if (proc.status !== 0) { process.stderr.write(`  failed (exit ${proc.status}): ${(proc.stderr ?? "").trim().slice(0, 400)}\n`); return 1; }
      process.stdout.write(`[ok]   ${c.label} run ${i}\n`);
    }
  }
  return 0;
}

function loadRuns(label: string, caseLabel: string): Projection[] {
  const dir = join(RUNS_DIR, label, caseLabel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => project(JSON.parse(readFileSync(join(dir, f), "utf-8"))));
}

// --- score --------------------------------------------------------------------------------------
function score(a: any): number {
  const label = a.label ?? a.model;
  const report: any = { label, cases: {} };
  for (const c of loadCases(a.case)) {
    const projs = loadRuns(label, c.label);
    if (projs.length < 2) { process.stdout.write(`[warn] ${c.label}: <2 runs (run 'generate' first)\n`); continue; }
    report.cases[c.label] = stability(projs);
  }
  printReport(report);
  if (a.save) { writeFileSync(a.save, JSON.stringify(report, null, 2)); process.stdout.write(`\nsaved -> ${a.save}\n`); }
  if (a.baseline) return gate(report, JSON.parse(readFileSync(a.baseline, "utf-8")), a.tol ?? 0.1);
  return 0;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
function printReport(report: any): void {
  process.stdout.write(`\n=== auto-grow stability | label=${report.label} ===\n`);
  for (const [name, s] of Object.entries<any>(report.cases)) {
    process.stdout.write(`\n${name}  (${s.runs} runs)\n`);
    process.stdout.write(`  spine agreement     ${pct(s.spine_jaccard)}  (Jaccard of spine symbols)\n`);
    process.stdout.write(`  culmination         ${pct(s.culmination_agreement)} agree → ${s.culmination_modal ?? "—"}\n`);
    process.stdout.write(`  tier agreement      ${pct(s.tier_agreement)}  (shared symbols tiered alike)\n`);
    process.stdout.write(`  spine length        min=${s.spine_len.min} max=${s.spine_len.max} mean=${s.spine_len.mean}\n`);
    process.stdout.write(`  seams               min=${s.seams.min} max=${s.seams.max} mean=${s.seams.mean}\n`);
  }
}

function gate(report: any, baseline: any, tol: number): number {
  const regressed: string[] = [];
  const f = (x: number) => x.toFixed(3);
  for (const [name, e] of Object.entries<any>(report.cases)) {
    const b = baseline.cases?.[name];
    if (!b) continue;
    for (const k of ["spine_jaccard", "culmination_agreement", "tier_agreement"]) {
      if (e[k] < b[k] - tol) regressed.push(`${name}: ${k} ${f(b[k])} -> ${f(e[k])}`);
    }
  }
  if (regressed.length) { process.stdout.write(`\n❌ STABILITY REGRESSION (tol=${tol}):\n${regressed.map((r) => `   - ${r}`).join("\n")}\n`); return 1; }
  process.stdout.write(`\n✅ no stability regression beyond tol=${tol}\n`);
  return 0;
}

// --- CLI ----------------------------------------------------------------------------------------
function parse(argv: string[]): any {
  const a: any = { cmd: argv[0], model: "claude-haiku-4-5", tol: 0.1 };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i], next = () => argv[++i];
    switch (v) {
      case "--runs": a.runs = parseInt(next(), 10); break;
      case "--model": a.model = next(); break;
      case "--label": a.label = next(); break;
      case "--case": a.case = next(); break;
      case "--promote-spine-path": a.promoteSpinePath = true; break;
      case "--force": a.force = true; break;
      case "--save": a.save = next(); break;
      case "--baseline": a.baseline = next(); break;
      case "--tol": a.tol = parseFloat(next()); break;
      default: if (v.startsWith("-")) process.stderr.write(`unknown flag: ${v}\n`);
    }
  }
  return a;
}

const a = parse(process.argv.slice(2));
if (a.cmd === "generate") process.exit(generate(a));
else if (a.cmd === "score") process.exit(score(a));
else { process.stderr.write("usage: autogrow_harness.ts (generate|score) [flags]\n"); process.exit(2); }
