#!/usr/bin/env bun
// Stability harness for the intent-conditioned subject-affinity pass + grow-confirmation. The affinity
// recall is a fragile SEMANTIC judgement, so we measure run-to-run agreement (gold-free, like the
// autogrow harness). The grow-probe (connect-back to the footprint) is DETERMINISTIC, so a surfaced hit's
// RESOLVED-vs-SUGGESTED classification is stable; what wobbles is only WHICH hits the LLM surfaces.
//
//   bun ts/eval/affinity_harness.ts --runs 5                        # committed cases
//   bun ts/eval/affinity_harness.ts --runs 5 --case private-app-bug-create
//   bun ts/eval/affinity_harness.ts --runs 5 --repo /p --intent "…" --subjects A,B,C \
//        --anchor-file path --anchor-symbol Sym                     # ad-hoc, any repo
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { affinity_grow } from "../src/codebase/grow/subject_affinity.js";
import { build_dependency_graph } from "../src/codebase/scan/import_scan.js";

const __dir = dirname(fileURLToPath(import.meta.url));
type Case = { label: string; repo: string; intent: string; subjects: string[]; anchorFile: string; anchorSymbol: string };
const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);

function parseArgs(argv: string[]): any {
  const a: any = { runs: 5 };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--runs": a.runs = parseInt(next() ?? "5", 10); break;
      case "--case": a.case = next(); break;
      case "--repo": a.repo = next(); break;
      case "--intent": a.intent = next(); break;
      case "--subjects": a.subjects = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--anchor-file": a.anchorFile = next(); break;
      case "--anchor-symbol": a.anchorSymbol = next(); break;
    }
  }
  return a;
}

function resolveCases(a: any): Case[] {
  if (a.repo && a.intent && a.subjects?.length && a.anchorFile && a.anchorSymbol)
    return [{ label: "adhoc", repo: a.repo, intent: a.intent, subjects: a.subjects, anchorFile: a.anchorFile, anchorSymbol: a.anchorSymbol }];
  const f = join(__dir, "affinity-cases.json");
  if (!existsSync(f)) return [];
  let all: Case[] = JSON.parse(readFileSync(f, "utf-8"));
  if (a.case) all = all.filter((c) => c.label === a.case);
  return all;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  for (const c of resolveCases(a)) {
    const repo = expanduser(c.repo);
    if (!existsSync(repo)) { console.log(`\n[skip] ${c.label}: repo not found at ${repo}`); continue; }
    // resolved footprint (deterministic, once) → files to EXCLUDE from affinity + connect-back target
    const fp = await build_dependency_graph(repo, c.anchorFile, c.anchorSymbol);
    const footprintFiles = (fp.nodes ?? []).map((n: any) => n.file).filter(Boolean);

    const surfaced = new Map<string, number>();      // file → # runs surfaced (LLM)
    const connectedOf = new Map<string, boolean>();  // file → grow connect-back (deterministic)
    const reason = new Map<string, string>();
    for (let r = 0; r < a.runs; r++) {
      const hits = await affinity_grow(repo, c.subjects, c.intent, footprintFiles);
      for (const h of hits) { surfaced.set(h.file, (surfaced.get(h.file) ?? 0) + 1); connectedOf.set(h.file, h.connected); reason.set(h.file, h.reason); }
    }
    const rows = [...surfaced.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const promoted = rows.filter(([f]) => connectedOf.get(f));               // RESOLVED via a real edge
    const suggestedOnly = rows.filter(([f]) => !connectedOf.get(f));         // edge-less → stays SUGGESTED
    const flaky = rows.filter(([, n]) => n > 0 && n < a.runs);
    console.log(`\n=== ${c.label} · ${a.runs} runs · footprint ${footprintFiles.length} files · subjects [${c.subjects.join(", ")}] ===`);
    console.log(`surfaced ${rows.length} | PROMOTED→resolved ${promoted.length} | suggested-only ${suggestedOnly.length} | flaky-surfacing ${flaky.length}`);
    console.log(`stability (surfaced unanimously / surfaced): ${(rows.length ? rows.filter(([, n]) => n === a.runs).length / rows.length * 100 : 100).toFixed(0)}%`);
    if (promoted.length) { console.log("● PROMOTED to RESOLVED (deterministic connect-back — LLM-independent):"); for (const [f, n] of promoted) console.log(`   ${f.split("/").slice(-1)[0]}  (surfaced ${n}/${a.runs})  — ${reason.get(f) ?? ""}`); }
    if (suggestedOnly.length) { console.log("· SUGGESTED only (no resolved edge back — genuinely fuzzy, LLM-dependent):"); for (const [f, n] of suggestedOnly) console.log(`   ${f.split("/").slice(-1)[0]}  (surfaced ${n}/${a.runs})`); }
  }
}

main();
