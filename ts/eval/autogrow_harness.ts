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
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const TS_CLI = join(__dir, "..", "src", "cli", "decompose.ts");
const CASES = join(__dir, "autogrow-cases.json");
const RUNS_DIR = join(__dir, "_autogrow_runs");
const BUN = process.env.HOME ? join(process.env.HOME, ".bun", "bin", "bun") : "bun";

// expectedAnchor / expectedCulmination are HUMAN-LABELED ground truth (a substring of the anchor symbol /
// the culmination's symbol@file). When present, the harness scores per-step ACCURACY (not just stability)
// and gates: a SELECTING step must clear ≥0.8 (ideally ≥0.9); the deterministic grow must be 100% (an
// identical footprint across runs). Absent → stability only.
type Case = { label: string; repo: string; intent: string; anchorFile?: string; symbol?: string;
  expectedAnchor?: string; expectedCulmination?: string };
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

type Projection = { spine: string[]; culmination: string | null; tiers: Map<string, string>; nSeams: number;
  anchor: string; footprint: string };
function project(model: any): Projection {
  const cl = (model.clusters ?? [])[0] ?? { seams: [] };
  const seams: any[] = cl.seams ?? [];
  const byId = new Map(seams.map((s) => [s.id, s]));
  const lbl = new Map<string, string>();
  for (const sm of seams) for (const h of (sm.hunks ?? [])) lbl.set(h.id, h.label);
  const spine = (cl.spine ?? []).map((id: string) => seamIdentity(byId.get(id))).filter((x: string) => x !== "?");
  // culmination identity: prefer the ranked top, else the selectedSeam pointer.
  const topRanked = (cl.culminationRanked ?? []).filter((r: any) => r.score > 0)[0];
  const culmId = topRanked?.id ?? model.selectedSeam;
  const culmination = culmId ? seamIdentity(byId.get(culmId)) : null;
  const tiers = new Map<string, string>();
  for (const s of seams) tiers.set(seamIdentity(s), s.tier ?? "supporting");
  // anchor SYMBOL (the entrypoint/anchor pick) + a hash of the GROWN footprint (the deterministic grow —
  // must be identical run-to-run for the same anchor).
  const anchor = lbl.get(model.anchor) ?? model.anchor ?? "?";
  const footprint = createHash("md5").update((model.edges ?? []).map((e: any) => `${e.from}>${e.to}:${e.kind}`).sort().join("|")).digest("hex").slice(0, 12);
  return { spine, culmination: culmination === "?" ? null : culmination, tiers, nSeams: seams.length, anchor, footprint };
}

// per-step ACCURACY vs human ground truth, + the determinism check. Substring match (the expected label is
// contained in the run's anchor symbol / culmination identity) so a short label like "scoring-cycle/
// repositories.ts" matches "save@…/scoring-cycle/repositories.ts".
function accuracy(projs: Projection[], c: Case): any | null {
  if (!c.expectedAnchor && !c.expectedCulmination) return null;
  const has = (hay: string | null, needle?: string) => !!needle && !!hay && hay.toLowerCase().includes(needle.toLowerCase());
  const frac = (xs: boolean[]) => xs.length ? round(xs.filter(Boolean).length / xs.length) : 0;
  // determinism: per distinct anchor, every run that picked it must grow the SAME footprint.
  const byAnchor = new Map<string, Set<string>>();
  for (const p of projs) (byAnchor.get(p.anchor) ?? byAnchor.set(p.anchor, new Set()).get(p.anchor)!).add(p.footprint);
  const footprint_stable = [...byAnchor.values()].every((s) => s.size === 1);
  return {
    anchor_accuracy: c.expectedAnchor ? frac(projs.map((p) => has(p.anchor, c.expectedAnchor))) : null,
    culmination_accuracy: c.expectedCulmination ? frac(projs.map((p) => has(p.culmination, c.expectedCulmination))) : null,
    footprint_stable,                                  // the deterministic grow must be 100%
    anchors_seen: [...byAnchor.keys()],
  };
}

// 0.8 = the floor (FAIL below), 0.9 = the target. A SELECTING step is graded against these; the
// deterministic footprint is pass/fail at 100%.
const ACC_FLOOR = 0.8, ACC_TARGET = 0.9;
const grade = (x: number | null): string => x === null ? "—" : x < ACC_FLOOR ? "❌FAIL" : x < ACC_TARGET ? "⚠ WARN" : "✅PASS";

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
    const entry: any = stability(projs);
    const acc = accuracy(projs, c);
    if (acc) entry.accuracy = acc;
    report.cases[c.label] = entry;
  }
  printReport(report);
  if (a.save) { writeFileSync(a.save, JSON.stringify(report, null, 2)); process.stdout.write(`\nsaved -> ${a.save}\n`); }
  // per-step ACCURACY gate (when any case carries ground truth): a SELECTING step below the floor, or a
  // non-deterministic footprint, FAILS — this is the 80%/100% bar as a CI gate.
  const accCode = accuracyGate(report);
  const baseCode = a.baseline ? gate(report, JSON.parse(readFileSync(a.baseline, "utf-8")), a.tol ?? 0.1) : 0;
  return accCode || baseCode;
}

function accuracyGate(report: any): number {
  const fails: string[] = [];
  for (const [name, e] of Object.entries<any>(report.cases)) {
    const acc = e.accuracy; if (!acc) continue;
    if (acc.anchor_accuracy !== null && acc.anchor_accuracy < ACC_FLOOR) fails.push(`${name}: anchor accuracy ${pct(acc.anchor_accuracy)} < ${pct(ACC_FLOOR)}  (saw: ${acc.anchors_seen.join(", ")})`);
    if (acc.culmination_accuracy !== null && acc.culmination_accuracy < ACC_FLOOR) fails.push(`${name}: culmination accuracy ${pct(acc.culmination_accuracy)} < ${pct(ACC_FLOOR)}`);
    if (!acc.footprint_stable) fails.push(`${name}: deterministic grow NOT 100% — same anchor grew different footprints`);
  }
  if (fails.length) { process.stdout.write(`\n❌ ACCURACY GATE FAILED:\n${fails.map((r) => `   - ${r}`).join("\n")}\n`); return 1; }
  if (Object.values<any>(report.cases).some((e) => e.accuracy)) process.stdout.write(`\n✅ accuracy gate: every SELECT step ≥ ${pct(ACC_FLOOR)}, deterministic grow = 100%\n`);
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
    if (s.accuracy) {
      const ac = s.accuracy;
      process.stdout.write(`  — accuracy vs ground truth (bar: ${pct(ACC_FLOOR)} floor / ${pct(ACC_TARGET)} target) —\n`);
      if (ac.anchor_accuracy !== null) process.stdout.write(`  anchor (SELECT)     ${pct(ac.anchor_accuracy)}  ${grade(ac.anchor_accuracy)}\n`);
      if (ac.culmination_accuracy !== null) process.stdout.write(`  culmination (SELECT) ${pct(ac.culmination_accuracy)}  ${grade(ac.culmination_accuracy)}\n`);
      process.stdout.write(`  grow (DETERMINISTIC) ${ac.footprint_stable ? "100%  ✅PASS" : "<100% ❌FAIL"}  (same anchor → same footprint)\n`);
    }
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
