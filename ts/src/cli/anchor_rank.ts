#!/usr/bin/env bun
// Port of src/codebase/anchor_rank.py main() — find + rank candidate anchors against a typed intent
// (or emit SUGGESTED boundary crossings for a symbol). Mirrors `python -m src.codebase.anchor_rank`.
import { readFileSync, writeFileSync } from "node:fs";
import { find_anchor_candidates, rank_anchors, suggest_crossings, _content_words } from "../codebase/anchor_rank.js";

function main(argv: string[]): number {
  const a: any = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--intent") a.intent = argv[++i];
    else if (v === "--repo") a.repo = argv[++i];
    else if (v === "--candidates") a.candidates = argv[++i];
    else if (v === "--crossings") a.crossings = true;
    else if (v === "--exclude-file") a.excludeFile = argv[++i];
    else if (v === "--out") a.out = argv[++i];
  }
  if (!a.intent) { process.stderr.write("error: --intent required\n"); return 2; }

  if (a.crossings) {
    if (!a.repo) { process.stderr.write("error: --crossings needs --repo\n"); return 2; }
    const ranked = suggest_crossings(a.repo, a.intent, { excludeFile: a.excludeFile });
    const text = JSON.stringify(ranked, null, 2);
    if (a.out) { writeFileSync(a.out, text); process.stdout.write(`Crossings: ${a.out}  (${ranked.length} suggestion(s))\n`); }
    else process.stdout.write(text + "\n");
    return 0;
  }
  let cands: any[];
  if (a.repo) cands = find_anchor_candidates(a.repo, [..._content_words(a.intent)].sort());
  else if (a.candidates) { try { cands = JSON.parse(readFileSync(a.candidates, "utf-8")); } catch (e) { process.stderr.write(`error: could not load candidates: ${(e as Error).message}\n`); return 2; } }
  else { process.stderr.write("error: pass --repo (scan) or --candidates (pre-gathered)\n"); return 2; }
  const ranked = rank_anchors(a.intent, cands);
  const text = JSON.stringify(ranked, null, 2);
  if (a.out) { writeFileSync(a.out, text); process.stdout.write(`Ranked: ${a.out}  (${ranked.length} candidate(s))\n`); }
  else process.stdout.write(text + "\n");
  return 0;
}

process.exit(main(process.argv.slice(2)));
