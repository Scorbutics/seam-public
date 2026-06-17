#!/usr/bin/env bun
// Stability harness for the intent-conditioned subject-affinity pass. That pass is a SEMANTIC LLM
// judgement (fragile), so — like the autogrow harness — we measure run-to-run AGREEMENT before trusting
// it, from day one. Gold-free: the structural candidate set is deterministic; what can wobble is which
// candidates the LLM marks RELATED. We report, per candidate, how consistently it's related across N runs.
//
//   bun ts/eval/affinity_harness.ts --runs 5                       # all committed cases
//   bun ts/eval/affinity_harness.ts --runs 5 --case private-app-bug-create
//   bun ts/eval/affinity_harness.ts --runs 5 --repo /p --intent "…" --subjects A,B,C   # ad-hoc (any repo)
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { subject_affinity } from "../src/codebase/subject_affinity.js";

const __dir = dirname(fileURLToPath(import.meta.url));
type Case = { label: string; repo: string; intent: string; subjects: string[]; exclude?: string[] };
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
    }
  }
  return a;
}

function resolveCases(a: any): Case[] {
  if (a.repo && a.intent && a.subjects?.length) return [{ label: "adhoc", repo: a.repo, intent: a.intent, subjects: a.subjects }];
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
    const counts = new Map<string, number>();        // file → # of runs that marked it related
    const reasons = new Map<string, string>();
    for (let r = 0; r < a.runs; r++) {
      const hits = subject_affinity(repo, c.subjects, c.intent, { exclude: c.exclude });
      for (const h of hits) { counts.set(h.file, (counts.get(h.file) ?? 0) + 1); reasons.set(h.file, h.reason); }
    }
    const rows = [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const unanimous = rows.filter(([, n]) => n === a.runs);
    const flaky = rows.filter(([, n]) => n > 0 && n < a.runs);
    const stability = rows.length ? unanimous.length / rows.length : 1;
    console.log(`\n=== ${c.label} · ${a.runs} runs · subjects [${c.subjects.join(", ")}] ===`);
    console.log(`intent: "${c.intent}"`);
    console.log(`surfaced (related ≥1 run): ${rows.length} | unanimous: ${unanimous.length} | flaky: ${flaky.length} | stability ${(stability * 100).toFixed(0)}%`);
    if (unanimous.length) { console.log("consistently related (all runs):"); for (const [f] of unanimous) console.log(`   ✓ ${f.split("/").slice(-1)[0]}  — ${reasons.get(f) ?? ""}`); }
    if (flaky.length) { console.log("FLAKY (run-to-run wobble — the instability to watch):"); for (const [f, n] of flaky) console.log(`   ~ ${f.split("/").slice(-1)[0]}  (${n}/${a.runs})`); }
  }
}

main();
