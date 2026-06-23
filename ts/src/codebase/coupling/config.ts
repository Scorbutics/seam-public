// COUPLING (data-coupling axis) tunables — caps + LLM budgets, centralized (values unchanged). Covers
// the shared-key engine (index.ts), the LLM key index, and the carrier-synthesis teacher (carrier/synth.ts).
// SEAM_KEY_BUDGET caps cold LLM key/matcher synthesis per run (a warm `.seam/` then costs nothing). The
// CLI default (60) suits a one-shot warm-up; an INTERACTIVE caller on a slow binary + large repo wants it
// LOW so a single grow doesn't fire dozens of serialized LLM subprocesses and blow the host's request
// deadline (the MCP server sets a modest default — see mcp/src/server.ts). 0 = apply cached adapters only.
const _keyBudget = process.env.SEAM_KEY_BUDGET !== undefined ? Math.max(0, Math.floor(Number(process.env.SEAM_KEY_BUDGET) || 0)) : 60;
// Floor-scan size guard: skip pathologically large files when scanning for shared keys. Hand-written source
// rarely exceeds ~1 MB; multi-MB files are generated/minified bundles (a webapp's vendor JS) where no intent-
// bearing key lives — and char-scanning them (raw-SQL's stringLiteralsOnly, comment-masking) dominates the
// index-build time and risks OOM. $SEAM_MAX_SCAN_BYTES overrides; 0 disables the cap.
const _maxScanBytes = process.env.SEAM_MAX_SCAN_BYTES !== undefined ? Math.max(0, Math.floor(Number(process.env.SEAM_MAX_SCAN_BYTES) || 0)) : 1_000_000;
export const COUPLING = {
  readerCap: 6,      // index: max complement nodes materialized per shared key
  maxScanBytes: _maxScanBytes, // floor scan: skip files larger than this (minified/generated bundles; $SEAM_MAX_SCAN_BYTES, 0=off)
  chainDepth: 1,     // index: hops to chain the data-flow boundary past the anchor (reader → its http-route)
  keyBudget: _keyBudget, // llm_key_index: max files sent to the LLM per run (bounds a huge repo; $SEAM_KEY_BUDGET)
  snippetCap: 8000,  // llm_key_index: chars of file snippets per batched LLM call (chunk boundary)
  perFile: 4000,     // llm_key_index: chars of one file's snippet
  synthBudget: 16,   // carrier/synth: max opaque carriers synthesized via LLM per run
};
