#!/usr/bin/env bun
// GROW-BORDER REGION harness — the §3 metric gate for shrinking the LLM out of the wave-grow intent
// border (docs: the border-shrink plan). For each case and each border CONFIG, it grows the footprint
// from the anchor and scores the emitted REGION (the set of files) against a hand-labelled goldRegion:
//   • region PRECISION / RECALL vs gold          (gated — no worse than baseline − tol)
//   • must-keep present / must-drop absent        (gated — no NEW adversarial break vs baseline)
//   • wall-clock, LLM-call count (grow-border), node count   (reported, NOT gated — they are the point)
//
//   bun ts/eval/grow_harness.ts eval                     # run the matrix, print the table
//   bun ts/eval/grow_harness.ts eval --save              # + write the baseline (ts/eval/grow-baseline.json)
//   bun ts/eval/grow_harness.ts eval --baseline          # + gate vs the committed baseline
//   bun ts/eval/grow_harness.ts eval --only booking      # filter cases by label substring
//   bun ts/eval/grow_harness.ts eval --config det,tol    # filter the config matrix
//
// The border configs (det = flood, tol = intent-cosine soft border, slm = the LLM border) are the
// baselines the deterministic replacements are measured against. det/tol are DETERMINISTIC + offline
// (they run in CI); slm needs a fast cheap backend (Ollama) and auto-SKIPS when none is present —
// never faking a number (execution discipline).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grow_to_terminals } from "../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../src/codebase/engine_ctx.js";
import { normpath } from "../src/core/resolve/walk.js";
import { reset_usage, get_usage, fastCheapBackend, available } from "../src/core/llm.js";
import { loadAddon } from "../src/codebase/rust_core.js";

// The embeddings live in the core now — ask IT whether it can embed, not a JS runtime that no longer computes
// anything for the grow.
const transformersAvailable = async (): Promise<boolean> => { try { return !!loadAddon()?.embedAvailable(); } catch { return false; } };

const __dir = dirname(fileURLToPath(import.meta.url));
const CASES = join(__dir, "autogrow-cases.json");
const BASELINE = join(__dir, "grow-baseline.json");
const BORDER_PASS = "grow-border";

interface GrowCase {
  label: string; repo: string; intent: string; anchorFile?: string; symbol?: string;
  goldRegion?: string[]; mustKeep?: string[]; mustDrop?: string[];
}
// A border config = the env vars + grow opts that select a border. New phases append configs here
// (centroid / blend / ubiquity / residual / concernMap) — the matrix and baseline grow with them.
interface Config { label: string; env?: Record<string, string>; opts?: Record<string, any>; needsBackend?: boolean; needsEmbed?: boolean; }
// NOTE on thresholds: hubFan/ubiquityFan default to 12 in production (calibrated for real repos). The
// hermetic fixture is tiny (max cross-module fan ~6), so the prior configs below scale the fan down to
// exercise the mechanism at all. A real-repo validation of the DEFAULT-flip uses the production defaults.
const CONFIGS: Config[] = [
  { label: "det", opts: { wave: true, borderLlm: false, hubGate: false } },                         // flood, no border
  { label: "tol", env: { SEAM_GROW_BORDER_TOL: "0.15" }, opts: { wave: true, borderLlm: false }, needsEmbed: true },   // intent-cosine soft border
  { label: "ubi", opts: { wave: true, borderLlm: false, ubiquity: true, ubiquityFan: 3 } },          // + deterministic ubiquity prior
  { label: "hub", opts: { wave: true, borderLlm: false, hubGate: true, hubFan: 3 } },                // + deterministic hub gate
  { label: "hububi", opts: { wave: true, borderLlm: false, hubGate: true, hubFan: 3, ubiquity: true, ubiquityFan: 3 } },   // both priors
  { label: "tier", opts: { wave: true, borderLlm: false, tierGrow: true }, needsEmbed: true },      // convergence tier rule (pivot-relevance up-climb); `nodes` = the fixture's convergence budget (2.4)
  { label: "tolblend", env: { SEAM_GROW_BORDER_TOL: "0.15" }, opts: { wave: true, borderLlm: false, borderField: "blend" }, needsEmbed: true },   // region-centroid blend field
  { label: "tolbpri", env: { SEAM_GROW_BORDER_TOL: "0.15" }, opts: { wave: true, borderLlm: false, borderField: "blend", ubiquity: true, ubiquityFan: 3, hubGate: true, hubFan: 3 }, needsEmbed: true },   // blend + both priors
  { label: "slm", opts: { wave: true, borderLlm: true }, needsBackend: true },                       // the LLM border
  { label: "slmres", opts: { wave: true, borderLlm: true, borderResidual: true, ubiquityFan: 3 }, needsBackend: true },   // residual band: SLM only the ambiguous middle
  { label: "slmrescm", opts: { wave: true, borderLlm: true, borderResidual: true, ubiquityFan: 3, concernMap: true }, needsBackend: true },   // + learned concern-map auto-drop
];

const round = (x: number, n = 3): number => Math.round(x * 10 ** n) / 10 ** n;
const expandHome = (p: string) => p.startsWith("~") ? join(process.env.HOME ?? "", p.slice(1)) : p;
const norm = (p: string) => normpath(p).replace(/^\.\//, "");

interface ConfigResult {
  skipped?: string; precision: number; recall: number; nodes: number; llmCalls: number; wallMs: number;
  region: string[]; mustKeepMissing: string[]; mustDropPresent: string[];
}

function scoreRegion(c: GrowCase, region: Set<string>): Pick<ConfigResult, "precision" | "recall" | "mustKeepMissing" | "mustDropPresent"> {
  const gold = new Set((c.goldRegion ?? []).map(norm));
  const inter = [...region].filter((f) => gold.has(f)).length;
  const precision = region.size ? inter / region.size : 1;      // fraction of the emitted region that is on-gold
  const recall = gold.size ? inter / gold.size : 1;             // fraction of the gold region recovered
  const mustKeepMissing = (c.mustKeep ?? []).map(norm).filter((f) => !region.has(f));
  const mustDropPresent = (c.mustDrop ?? []).map(norm).filter((f) => region.has(f));
  return { precision: round(precision), recall: round(recall), mustKeepMissing, mustDropPresent };
}

async function runConfig(c: GrowCase, cfg: Config): Promise<ConfigResult> {
  const repo = expandHome(c.repo);
  if (!existsSync(repo)) return blank(`repo not found (${c.repo})`);
  if (cfg.needsBackend && !(fastCheapBackend() || (cfg.opts?.borderLlm && available()))) return blank("no LLM backend");
  if (cfg.needsEmbed && !(await transformersAvailable())) return blank("no embeddings (transformers absent)");
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(cfg.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
  // clear the OTHER configs' env so a stale SEAM_GROW_BORDER_TOL can't leak between configs in one process
  for (const other of CONFIGS) for (const k of Object.keys(other.env ?? {})) if (!(k in (cfg.env ?? {}))) { saved[k] ??= process.env[k]; delete process.env[k]; }
  reset_usage();
  const t0 = performance.now();
  try {
    const [data] = await grow_to_terminals(repo, c.anchorFile!, c.symbol!, {
      intent: c.intent, dataCoupling: true, dataCouplingLlm: false, maxNodes: 500, ctx: new EngineCtx(), ...cfg.opts,
    });
    const wallMs = Math.round(performance.now() - t0);
    const region = new Set<string>((data.nodes as any[]).filter((n) => n.file).map((n) => norm(n.file)));
    const usage = get_usage();
    return { ...scoreRegion(c, region), nodes: (data.nodes as any[]).length, llmCalls: usage.by_tag?.[BORDER_PASS] ?? 0,
      wallMs, region: [...region].sort() };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const blank = (why: string): ConfigResult => ({ skipped: why, precision: 0, recall: 0, nodes: 0, llmCalls: 0, wallMs: 0, region: [], mustKeepMissing: [], mustDropPresent: [] });

type Report = Record<string, Record<string, ConfigResult>>;   // case → config → result

function loadCases(only?: string): GrowCase[] {
  let cs: GrowCase[] = (JSON.parse(readFileSync(CASES, "utf-8")) as GrowCase[]).filter((c) => c.goldRegion && c.anchorFile && c.symbol);
  if (only) cs = cs.filter((c) => c.label.includes(only));
  return cs;
}

async function evalMatrix(only?: string, configFilter?: Set<string>): Promise<Report> {
  const report: Report = {};
  for (const c of loadCases(only)) {
    report[c.label] = {};
    for (const cfg of CONFIGS) {
      if (configFilter && !configFilter.has(cfg.label)) continue;
      report[c.label][cfg.label] = await runConfig(c, cfg);
    }
  }
  return report;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
function printReport(report: Report): void {
  process.stdout.write(`\n=== grow-border region matrix ===\n`);
  for (const [name, byCfg] of Object.entries(report)) {
    process.stdout.write(`\n${name}\n`);
    for (const [cfg, r] of Object.entries(byCfg)) {
      if (r.skipped) { process.stdout.write(`  ${cfg.padEnd(6)} SKIPPED (${r.skipped})\n`); continue; }
      const mk = r.mustKeepMissing.length ? ` ✗keep:${r.mustKeepMissing.join(",")}` : " ✓keep";
      const md = r.mustDropPresent.length ? ` ✗drop:${r.mustDropPresent.join(",")}` : " ✓drop";
      process.stdout.write(`  ${cfg.padEnd(6)} P ${pct(r.precision)}  R ${pct(r.recall)}  nodes ${r.nodes}  llm ${r.llmCalls}  ${r.wallMs}ms${mk}${md}\n`);
    }
  }
}

// GATE — regression vs the committed baseline, per (case, config). Numeric metrics fail below base − tol.
// The adversarial sets fail on a NEW break only (a must-keep the baseline kept but this run drops, or a
// must-drop the baseline dropped but this run keeps) — so det keeping everything isn't a false failure.
function gate(report: Report, baseline: Report, tol: number): number {
  const regressed: string[] = [];
  for (const [name, byCfg] of Object.entries(report)) {
    const base = baseline[name]; if (!base) continue;
    for (const [cfg, r] of Object.entries(byCfg)) {
      const b = base[cfg]; if (!b || r.skipped || b.skipped) continue;
      // SLM-backed configs are NON-DETERMINISTIC (the model's verdict on the residual middle wobbles run-to-run),
      // so their region precision/recall are REPORTED, not gated — a single-run gate would flake. Only the
      // deterministic configs (det / tol / priors) are gated. (Stable SLM gating would need N-run aggregation.)
      if (CONFIGS.find((c) => c.label === cfg)?.needsBackend) continue;
      if (r.precision < b.precision - tol) regressed.push(`${name}/${cfg}: precision ${b.precision} -> ${r.precision}`);
      if (r.recall < b.recall - tol) regressed.push(`${name}/${cfg}: recall ${b.recall} -> ${r.recall}`);
      const baseKept = new Set(b.mustKeepMissing);
      for (const f of r.mustKeepMissing) if (!baseKept.has(f)) regressed.push(`${name}/${cfg}: newly DROPS must-keep ${f}`);
      const baseDropped = new Set(b.mustDropPresent);
      for (const f of r.mustDropPresent) if (!baseDropped.has(f)) regressed.push(`${name}/${cfg}: newly KEEPS must-drop ${f}`);
    }
  }
  if (regressed.length) { process.stdout.write(`\n❌ GROW-BORDER REGRESSION (tol=${tol}):\n${regressed.map((r) => `   - ${r}`).join("\n")}\n`); return 1; }
  process.stdout.write(`\n✅ no grow-border regression beyond tol=${tol}\n`);
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "eval") { process.stderr.write("usage: grow_harness.ts eval [--only <substr>] [--config a,b] [--save] [--baseline] [--tol N]\n"); process.exit(2); }
  const flag = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const only = flag("--only");
  const configFilter = flag("--config") ? new Set(flag("--config")!.split(",")) : undefined;
  const tol = flag("--tol") ? parseFloat(flag("--tol")!) : 0.05;
  const report = await evalMatrix(only, configFilter);
  printReport(report);
  if (args.includes("--save")) { writeFileSync(BASELINE, JSON.stringify(report, null, 2) + "\n"); process.stdout.write(`\nsaved baseline → ${BASELINE}\n`); }
  if (args.includes("--baseline")) process.exit(gate(report, JSON.parse(readFileSync(BASELINE, "utf-8")), tol));
}

if (import.meta.main) await main();
