#!/usr/bin/env bun
// DATA-COUPLING harness + the FULL LLM EVAL GOLD LOOP. Measures whether the engine RECOVERS known
// producer↔consumer couplings from an anchor, against a GOLD (each case's `expect`), under a config —
// and, because the LLM teachers are NON-DETERMINISTIC, across N runs (recall + precision + stability).
// This is what makes teacher-3 (LLM-learned adapters) "harness-validated": does the LLM regenerate the
// gold edges, reliably, without fabricating extras (grounding holds)?
//
//   bun ts/eval/coupling_harness.ts score [--no-adapters] [--llm]      # quick single live run (no gold)
//   bun ts/eval/coupling_harness.ts generate [--runs 3] [--only <substr>]   # cache N runs per case (LLM live)
//   bun ts/eval/coupling_harness.ts eval [--save B] [--baseline B]     # recall/precision/stability + gate
//
// Each LLM run uses a FRESH fixture copy + reset module caches, so it RE-SYNTHESIZES (measuring synthesis
// stability, not the .seam cache). Deterministic cases (no llm) run once. The committed fixture stays clean.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadAddon, toResolvedGraph } from "../src/codebase/grow/rust_core.js";
import { rustDiscover } from "../src/codebase/grow/rust_discover.js";
import { isFlowSubject } from "../src/codebase/coupling/index.js";
import { _resetKeyCacheMem } from "../src/codebase/coupling/key_store.js";
import { _resetCarrierCacheMem } from "../src/codebase/coupling/carrier/cache.js";
import { _resetParseCache } from "../src/languages/ruby/carrier_trace.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const CASES = join(__dir, "coupling-cases.json");
const FIXTURES = join(__dir, "coupling-fixtures");
const RUNS_DIR = join(__dir, "_coupling_runs");
const BASELINE = join(__dir, "coupling-baseline.json");

export interface CouplingCase {
  name: string; repo: string; anchorFile: string; symbol: string;
  config?: { noAdapters?: boolean; llm?: boolean };
  goldComplete?: boolean;                 // the gold lists ALL real couplings → precision is meaningful
  expect: { value: string }[];
}
export interface CaseScore { name: string; recall: number; recovered: string[]; missing: string[]; boundaries: string[] }

const mean = (a: number[]): number => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const round = (x: number, n = 3): number => Math.round(x * 10 ** n) / 10 ** n;
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size && !b.size) return 1;
  let inter = 0; for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
};

// Run the footprint once and score recovered coupling BOUNDARIES (key-kind coupling nodes) vs the gold.
export async function scoreCouplingCase(repo: string, c: CouplingCase, opts: { noAdapters?: boolean; llm?: boolean } = {}): Promise<CaseScore> {
  const prev = process.env.SEAM_NO_ADAPTERS;
  if (opts.noAdapters) process.env.SEAM_NO_ADAPTERS = "1"; else delete process.env.SEAM_NO_ADAPTERS;
  try {
    const core = loadAddon();
    // `process.env` does not cross the napi boundary — SEAM_NO_ADAPTERS above is set for THIS process, so the
    // addon has to be told about it or the "unlink the adapters" arm measures the linked floor.
    core.syncSeamEnv(Object.entries(process.env).filter(([k, v]) => k.startsWith("SEAM_") && v !== undefined) as [string, string][]);
    core.resetCaches(repo);
    // The core REPLAYS the flywheel from `.seam` rather than learning inside the overlay, so an LLM arm has to
    // warm it FIRST. On the TypeScript path this was driven lazily from resolveCoupling, which is why the
    // option could simply be passed down and forgotten about.
    if (opts.llm) await rustDiscover(repo, { scopeFiles: [c.anchorFile] });
    const g = toResolvedGraph(core.buildFootprint(repo, c.anchorFile, c.symbol, "up", true, null, null, null));
    const coupling = g.nodes.filter((n: any) => n.coupling);
    const recovered = coupling.map((n: any) => String(n.symbol));
    const boundaries = coupling.filter((n: any) => isFlowSubject(n.kind)).map((n: any) => String(n.symbol));   // the key boundaries (table/route/data-file/…)
    const bset = new Set(boundaries);
    const expected = c.expect.map((e) => e.value);
    const missing = expected.filter((v) => !bset.has(v));
    return { name: c.name, recall: expected.length ? (expected.length - missing.length) / expected.length : 1, recovered, missing, boundaries };
  } finally {
    if (prev === undefined) delete process.env.SEAM_NO_ADAPTERS; else process.env.SEAM_NO_ADAPTERS = prev;
  }
}

const loadCases = (only?: string): CouplingCase[] => {
  let cs: CouplingCase[] = JSON.parse(readFileSync(CASES, "utf-8"));
  if (only) cs = cs.filter((c) => c.name.includes(only));
  return cs;
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
// each run is INDEPENDENT: a fresh fixture copy (unique path → fresh per-path caches, no .seam) + reset budgets/parse
function freshRun(repo: string): string {
  const d = mkdtempSync(join(tmpdir(), "cev-")); cpSync(join(FIXTURES, repo), d, { recursive: true }); rmSync(join(d, ".seam"), { recursive: true, force: true });
  _resetKeyCacheMem(); _resetCarrierCacheMem(); _resetParseCache();
  return d;
}

async function generate(runs: number, only?: string): Promise<number> {
  mkdirSync(RUNS_DIR, { recursive: true });
  for (const c of loadCases(only)) {
    const n = c.config?.llm ? runs : 1;   // deterministic configs need only one run
    const boundarySets: string[][] = [];
    for (let r = 0; r < n; r++) {
      const repo = freshRun(c.repo);
      try { boundarySets.push((await scoreCouplingCase(repo, c, c.config ?? {})).boundaries.sort()); }
      finally { rmSync(repo, { recursive: true, force: true }); }
    }
    writeFileSync(join(RUNS_DIR, slug(c.name) + ".json"), JSON.stringify({ name: c.name, gold: c.expect.map((e) => e.value), goldComplete: !!c.goldComplete, runs: boundarySets }, null, 2));
    process.stderr.write(`  generated ${n} run(s): ${c.name}\n`);
  }
  return 0;
}

type Report = Record<string, { recall: number; precision: number; stability: number; runs: number }>;
function aggregate(only?: string): Report {
  const rep: Report = {};
  for (const c of loadCases(only)) {
    const f = join(RUNS_DIR, slug(c.name) + ".json");
    if (!existsSync(f)) continue;
    const { gold, goldComplete, runs } = JSON.parse(readFileSync(f, "utf-8")) as { gold: string[]; goldComplete: boolean; runs: string[][] };
    const goldSet = new Set(gold);
    const recalls: number[] = [], precisions: number[] = [];
    for (const b of runs) {
      const bset = new Set(b);
      recalls.push(gold.length ? gold.filter((g) => bset.has(g)).length / gold.length : 1);
      if (goldComplete && bset.size) precisions.push([...bset].filter((x) => goldSet.has(x)).length / bset.size);   // set-based: no double-count
    }
    const sets = runs.map((b) => new Set(b));
    let stab = 1; if (sets.length > 1) { const js: number[] = []; for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) js.push(jaccard(sets[i], sets[j])); stab = mean(js); }
    rep[c.name] = { recall: round(mean(recalls)), precision: round(precisions.length ? mean(precisions) : 1), stability: round(stab), runs: runs.length };
  }
  return rep;
}

function gate(rep: Report, base: Report, tol = 0.05): number {
  let fail = 0;
  for (const [name, m] of Object.entries(rep)) {
    const b = base[name]; if (!b) continue;
    for (const k of ["recall", "precision", "stability"] as const)
      if ((m as any)[k] < (b as any)[k] - tol) { process.stderr.write(`  REGRESSION ${name}: ${k} ${(m as any)[k]} < ${(b as any)[k]} - ${tol}\n`); fail = 1; }
  }
  return fail;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
  const only = flag("--only");

  if (args[0] === "score") {   // quick single LIVE run (no gold loop)
    const opts = { noAdapters: args.includes("--no-adapters"), llm: args.includes("--llm") };
    let sum = 0, n = 0;
    for (const c of loadCases(only)) { const s = await scoreCouplingCase(join(FIXTURES, c.repo), c, c.config ?? opts); n++; sum += s.recall; console.log(`  ${c.name}: recall ${(s.recall * 100).toFixed(0)}%${s.missing.length ? `  missing: ${s.missing.join(", ")}` : ""}`); }
    console.log(`mean recall: ${n ? ((sum / n) * 100).toFixed(0) : 0}%`);
    return;
  }
  if (args[0] === "generate") { process.exit(await generate(Number(flag("--runs") ?? 3), only)); }
  if (args[0] === "eval") {
    const rep = aggregate(only);
    for (const [name, m] of Object.entries(rep)) console.log(`  ${name}\n     recall ${m.recall}  precision ${m.precision}  stability ${m.stability}  (${m.runs} run${m.runs > 1 ? "s" : ""})`);
    if (args.includes("--save")) { writeFileSync(BASELINE, JSON.stringify(rep, null, 2)); console.log(`saved baseline → ${BASELINE}`); }
    if (args.includes("--baseline")) { const code = gate(rep, JSON.parse(readFileSync(BASELINE, "utf-8"))); console.log(code ? "GATE: FAIL" : "GATE: ok"); process.exit(code); }
    return;
  }
  console.error("usage: coupling_harness.ts <score|generate [--runs N]|eval [--save|--baseline]> [--only <substr>]");
  process.exit(2);
}

if (import.meta.main) await main();
