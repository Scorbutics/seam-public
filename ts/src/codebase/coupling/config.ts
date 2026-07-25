// COUPLING (data-coupling axis) tunables — caps + LLM budgets, centralized (values unchanged). Covers
// the shared-key engine (index.ts), the LLM key index, and the carrier-synthesis teacher (carrier/synth.ts).
// SEAM_KEY_BUDGET caps cold LLM key/matcher synthesis per run (a warm `.seam/` then costs nothing). The
// CLI default (60) suits a one-shot warm-up; an INTERACTIVE caller on a slow binary + large repo wants it
// LOW so a single grow doesn't fire dozens of serialized LLM subprocesses and blow the host's request
// deadline (the MCP server sets a modest default — see mcp/src/server.ts). 0 = apply cached adapters only.
const _keyBudget = process.env.SEAM_KEY_BUDGET !== undefined ? Math.max(0, Math.floor(Number(process.env.SEAM_KEY_BUDGET) || 0)) : 60;
// Floor-scan size guard — an OPT-IN OOM backstop, OFF by default. It WAS a 1 MB skip (a stopgap for the
// `split("")` blow-up on a webapp's minified bundles), but skipping loses real couplings: a large generated
// data-access file holds genuine shared keys. The allocation-light masking rewrite made scanning big files
// cheap + bounded, so the default is now "scan everything, lose nothing." Set $SEAM_MAX_SCAN_BYTES (bytes)
// to cap on a repo with a pathological multi-hundred-MB blob; 0 (default) = no cap.
const _maxScanBytes = process.env.SEAM_MAX_SCAN_BYTES !== undefined ? Math.max(0, Math.floor(Number(process.env.SEAM_MAX_SCAN_BYTES) || 0)) : 0;
export const COUPLING = {
  readerCap: 6,      // index: max complement nodes materialized per shared key
  // HUB DAMPING: a key whose far-side fan-in (distinct complement files) exceeds `hubFan` is INFRASTRUCTURE,
  // not a domain channel — a shared EntityManager / session / audit log touched by half the codebase. Coupling
  // on it is generic noise that floods (and, through grow re-anchoring, COMPOUNDS) the footprint. So it
  // materializes only `hubReaderCap` complement(s) instead of `readerCap`; the rest is recorded as the
  // existing shared-key-fanout blindspot (honest, not silent). A domain table with a handful of users is
  // unaffected. Structural (degree), not a name match — tunable via env for big monorepos.
  hubFan: Number(process.env.SEAM_COUPLING_HUB_FAN ?? 16),          // fan-in above which a key is treated as an infra hub (distinct from the grow's SEAM_HUB_FAN)
  hubReaderCap: Number(process.env.SEAM_HUB_READER_CAP ?? 1),  // complements materialized for a hub key
  // TARGETED bridge cost bound (couplingOtherSides): max DISTINCT candidate files key-scanned per run. Replaces
  // the old per-key 200-candidate input cap, which bounded the INPUT (and so the ANSWER) instead of the cost.
  // Sized from measurement, not a guess: on cal.com a candidate scan costs ~1.0ms (3140 distinct files in 3.16s)
  // and the whole repo holds 7421 scannable files, so 4000 is a ~4s absolute worst case for a run in which EVERY
  // key is a repo-wide hub with fewer complements than READER_CAP — while the real anchors measured stay far
  // under it (getBusyTimes: 462 scans; the 5-key get.handler: 1334). $SEAM_CAND_SCAN_BUDGET.
  candidateScanBudget: Number(process.env.SEAM_CAND_SCAN_BUDGET ?? 4000),
  nodeKeyCap: Number(process.env.SEAM_NODE_KEY_CAP ?? 16),  // index: max shared keys ONE node surfaces (caps a hub file emitting dozens of UI events — keeps the most specific; $SEAM_NODE_KEY_CAP)
  complementBudget: Number(process.env.SEAM_COMPLEMENT_BUDGET ?? 250), // grow-wide cap on materialized complement units (tree-sitter parses) — bounds a hub's data-coupling fan so a bad/central anchor can't run for ages; $SEAM_COMPLEMENT_BUDGET
  maxScanBytes: _maxScanBytes, // floor scan: skip files larger than this — OOM backstop, $SEAM_MAX_SCAN_BYTES, 0=off (default: scan all)
  chainDepth: 1,     // index: hops to chain the data-flow boundary past the anchor (reader → its http-route)
  keyBudget: _keyBudget, // llm_key_index: max files sent to the LLM per run (bounds a huge repo; $SEAM_KEY_BUDGET)
  snippetCap: 8000,  // llm_key_index PER-FILE pass: chars of file snippets per batched LLM call (chunk boundary)
  perFile: 4000,     // llm_key_index PER-FILE pass: chars of one file's snippet (DEPTH — list every key in a file)
  // key_matcher RULE pass wants BREADTH not depth: a reusable shape is spotted by RECURRENCE across files, and
  // each occurrence is short (`getItem('x')`), so use small per-file snippets + a larger total → many more
  // files visible in one call. (private-app audit: the matcher synth saw only ~2 files, missing the localStorage
  // `cache` pattern recurring across ~6 — which the per-file pass then had to list literally instead.)
  matcherPerFile: 1400,    // chars of one file's snippet for the matcher synth
  matcherSnippetCap: 16000, // total snippet budget for the matcher synth (≈ 11 files vs the old ~2)
  synthBudget: 16,   // carrier/synth: max opaque carriers synthesized via LLM per run
};
