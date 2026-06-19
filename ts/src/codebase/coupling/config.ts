// COUPLING (data-coupling axis) tunables — caps + LLM budgets, centralized (values unchanged). Covers
// the shared-key engine (index.ts), the LLM key index, and the carrier-synthesis teacher (carrier/synth.ts).
export const COUPLING = {
  readerCap: 6,      // index: max complement nodes materialized per shared key
  chainDepth: 1,     // index: hops to chain the data-flow boundary past the anchor (reader → its http-route)
  keyBudget: 60,     // llm_key_index: max files sent to the LLM per run (bounds a huge repo)
  snippetCap: 8000,  // llm_key_index: chars of file snippets per batched LLM call (chunk boundary)
  perFile: 4000,     // llm_key_index: chars of one file's snippet
  synthBudget: 16,   // carrier/synth: max opaque carriers synthesized via LLM per run
};
