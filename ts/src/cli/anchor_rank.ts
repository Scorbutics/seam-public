#!/usr/bin/env bun
// Port of src/codebase/anchor_rank.py main() — find + rank candidate anchors against a typed intent
// (or emit SUGGESTED boundary crossings for a symbol). Mirrors `python -m src.codebase.anchor_rank`.
import { readFileSync, writeFileSync } from "node:fs";
import { find_anchor_candidates, rank_anchors, suggest_crossings, _content_words } from "../codebase/anchor_rank.js";
import { expand_intent_terms } from "../codebase/intent_expand.js";
import { select_anchor } from "../codebase/anchor_select.js";
import { available } from "../core/llm.js";

async function main(argv: string[]): Promise<number> {
  const a: any = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--intent") a.intent = argv[++i];
    else if (v === "--repo") a.repo = argv[++i];
    else if (v === "--candidates") a.candidates = argv[++i];
    else if (v === "--crossings") a.crossings = true;
    else if (v === "--select") a.select = true;
    else if (v === "--top-k") a.topK = parseInt(argv[++i] ?? "8", 10);
    else if (v === "--no-judge") a.noJudge = true;   // structural-only pick (skip the LLM judge)
    else if (v === "--no-expand") a.noExpand = true; // skip LLM query-expansion (recall = stems only)
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--claude-bin") a.claudeBin = argv[++i];
    else if (v === "--llm-expand") a.llmExpand = true;
    else if (v === "--llm-probe") a.llmProbe = true;
    else if (v === "--exclude-file") a.excludeFile = argv[++i];
    else if (v === "--out") a.out = argv[++i];
  }

  // Capability probe for the client (no LLM call): is an LLM backend resolvable at all? The client
  // hides the "Search with the LLM…" affordance when not, so it never offers a dead button.
  if (a.llmProbe) {
    const text = JSON.stringify({ llm: available() });
    if (a.out) writeFileSync(a.out, text); else process.stdout.write(text + "\n");
    return 0;
  }
  if (!a.intent) { process.stderr.write("error: --intent required\n"); return 2; }

  // --select: the AUTO entry ramp — no manual pick. Generate candidates, shallow-probe each, and rank
  // by the connectedness of the grown footprint. Emits the chosen anchor + the ranked probed list (with
  // structural metrics) so a client can auto-grow from `chosen` or show the reasoning.
  if (a.select) {
    if (!a.repo) { process.stderr.write("error: --select needs --repo\n"); return 2; }
    const result = await select_anchor(a.repo, a.intent, { topK: a.topK, llmExpand: !a.noExpand, judge: !a.noJudge, model: a.model, claudeBin: a.claudeBin });
    const text = JSON.stringify(result, null, 2);
    if (a.out) { writeFileSync(a.out, text); process.stdout.write(`Selected: ${a.out}  (chosen=${result.chosen?.name ?? "none"} by ${result.chosenBy}, ${result.ranked.length} probed)\n`); }
    else process.stdout.write(text + "\n");
    return 0;
  }

  if (a.crossings) {
    if (!a.repo) { process.stderr.write("error: --crossings needs --repo\n"); return 2; }
    const ranked = suggest_crossings(a.repo, a.intent, { excludeFile: a.excludeFile });
    const text = JSON.stringify(ranked, null, 2);
    if (a.out) { writeFileSync(a.out, text); process.stdout.write(`Crossings: ${a.out}  (${ranked.length} suggestion(s))\n`); }
    else process.stdout.write(text + "\n");
    return 0;
  }
  // --llm-expand: the LLM proposes extra keywords from the intent; they widen the deterministic
  // candidate scan AND join the ranking vocabulary. Every proposal is grounded by the scan, so junk
  // terms simply find nothing. Empty (graceful) when no LLM backend is available.
  const extra = a.llmExpand ? expand_intent_terms(a.intent) : [];
  let cands: any[];
  if (a.repo) {
    const keywords = [...new Set([..._content_words(a.intent), ...extra])].sort();
    cands = find_anchor_candidates(a.repo, keywords);
  }
  else if (a.candidates) { try { cands = JSON.parse(readFileSync(a.candidates, "utf-8")); } catch (e) { process.stderr.write(`error: could not load candidates: ${(e as Error).message}\n`); return 2; } }
  else { process.stderr.write("error: pass --repo (scan) or --candidates (pre-gathered)\n"); return 2; }
  const ranked = rank_anchors(a.intent, cands, 12, extra);
  const text = JSON.stringify(ranked, null, 2);
  if (a.out) { writeFileSync(a.out, text); process.stdout.write(`Ranked: ${a.out}  (${ranked.length} candidate(s))\n`); }
  else process.stdout.write(text + "\n");
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
