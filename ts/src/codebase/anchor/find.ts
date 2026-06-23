// FIND_ANCHOR — the auto-anchor façade. The full "pick the entry-point symbol an intent points at"
// pipeline behind ONE call, so the CLI no longer orchestrates the steps: (1) when an LLM is available,
// run the HTTP entry-point seed pass and the intent-term expansion CONCURRENTLY (two independent
// pre-decision passes), then (2) feed both into the probe→judge `select_anchor`. Returns DATA only
// (chosen anchor + provenance + noFlow + the entry candidate for logging); presentation (stdout/err)
// stays in the caller.
import { available } from "../../core/llm.js";
import { enumerate_entrypoints, select_entrypoint_llm, entrypoint_anchor } from "./entrypoint_select.js";
import { expand_intent_terms_async } from "./intent_expand.js";
import { select_anchor, type ProbedAnchor } from "./anchor_select.js";
import { pick_anchor, type AnchorAlt } from "./anchor_pick.js";

export interface FindAnchorOpts { dataCoupling?: boolean; model?: string; claudeBin?: string | null; anchorRecall?: "lexical" | "embed"; select?: "pick" | "probe" }
export interface FindAnchorResult {
  chosen: ProbedAnchor | null;
  chosenBy: "llm" | "structural" | "pick" | "none";
  noFlow?: boolean;
  entryCandidate?: { path: string; symbol: string; file: string };   // the HTTP entry seed, for a [entry-candidate] log
  alternatives?: AnchorAlt[];   // runner-up anchors (pick path) — offered when the footprint reads off-intent
}

export async function find_anchor(repo: string, intent: string, opts: FindAnchorOpts = {}): Promise<FindAnchorResult> {
  // DIRECT PICK is the DEFAULT: ONE LLM pass names the anchor from rich candidate passages — no probe
  // sweep, no entrypoint-select/expand passes (the grow that follows IS the connectedness check). ~6×
  // faster than probe→judge on a big repo, same anchor on the cases measured. Falls THROUGH to probe→judge
  // when it yields nothing (no LLM / no candidates), so it never regresses to "no anchor". Opt OUT of pick
  // with select:"probe" (CLI `--anchor-select probe`) — the probe path is kept, just no longer default.
  if (opts.select !== "probe") {
    const p = await pick_anchor(repo, intent, { model: opts.model, claudeBin: opts.claudeBin });
    if (p.chosen) return { chosen: p.chosen, chosenBy: "pick", alternatives: p.alternatives };
  }
  const seeds: { name: string; file: string; kind: string }[] = [];
  let expandTerms: string[] | undefined;
  let entryCandidate: FindAnchorResult["entryCandidate"];
  if (available(opts.claudeBin)) {
    const eps = enumerate_entrypoints(repo);
    // entrypoint-select and intent-expand are INDEPENDENT LLM passes that both precede the anchor
    // decision — run them CONCURRENTLY to save a round-trip on the dominant LLM-pass cost.
    const [pick, terms] = await Promise.all([
      select_entrypoint_llm(intent, eps, { model: opts.model, claudeBin: opts.claudeBin }),
      expand_intent_terms_async(intent, { model: opts.model, claudeBin: opts.claudeBin }),
    ]);
    expandTerms = terms;
    if (pick) {
      const [file, symbol] = await entrypoint_anchor(repo, pick);
      seeds.push({ name: symbol, file, kind: "route" });   // a SEED candidate (decide-LAST), never a preemptive override
      entryCandidate = { path: pick.path, symbol, file };
    }
  }
  const sel = await select_anchor(repo, intent, {
    dataCoupling: opts.dataCoupling, model: opts.model, claudeBin: opts.claudeBin,
    anchorRecall: opts.anchorRecall === "lexical" ? "lexical" : "embed", seeds, expandTerms,
  });
  return { chosen: sel.chosen, chosenBy: sel.chosenBy, noFlow: sel.noFlow, entryCandidate };
}
