// ANCHOR phase — public API. Pick the entry-point symbol an intent query points at (candidate recall →
// probe → LLM judge), the HTTP entry-point seed pass, and the intent-term expansion for recall.
// NOTE: embed recall + relevance run via def_embed.embedScoreDefs, which lazily imports transformers (the
// ~23 MB model) only when actually called — so the default build / .vsix degrades free without it.
export { find_anchor, type FindAnchorOpts, type FindAnchorResult } from "./find.js";
export { rank_anchors, find_anchor_candidates, suggest_crossings } from "./anchor_rank.js";
export { select_anchor, probe_anchor, judge_anchor_llm, footprint_metrics, struct_score, type ProbeMetrics, type ProbedAnchor } from "./anchor_select.js";
export { enumerate_entrypoints, select_entrypoint_llm, entrypoint_anchor, type EntryPoint } from "./entrypoint_select.js";
export { expand_intent_terms, expand_intent_terms_async } from "./intent_expand.js";
