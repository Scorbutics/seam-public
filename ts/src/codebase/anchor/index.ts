// ANCHOR phase — candidate recall + the probe→judge anchor selection, exposed for the standalone
// `cli/anchor_rank` subtool (the extension's anchor-rank feature). NOTE: the whole-repo auto-anchor
// SELECTION for a no-symbol grow (find_anchor + the entry-point / anchor-pick LLM passes) was removed —
// the codebase no-symbol path is now CENTER-FIRST (grow/center_repo.ts). embed recall + relevance run via
// def_embed.embedScoreDefs, which lazily imports transformers only when called (the .vsix degrades free).
export { rank_anchors, find_anchor_candidates, suggest_crossings } from "./anchor_rank.js";
export { select_anchor, probe_anchor, judge_anchor_llm, footprint_metrics, struct_score, type ProbeMetrics, type ProbedAnchor } from "./anchor_select.js";
export { expand_intent_terms, expand_intent_terms_async } from "./intent_expand.js";
