// Run-scoped LEDGER of the LEARNED `.seam/` adapters a run TOUCHED — which were CONSULTED (replayed
// offline, the "deterministic-forever" half) and which were NEWLY learned this run (the LLM fired once).
// Pure observability, no correctness impact: it makes the learned-adapter FLYWHEEL visible so a run can
// REPORT the compounding asset it used + grew, and the user can promote it (`seam-adapters`). The CLI
// shells out one process per analysis, so module scope == run scope; `resetLedger()` is for the in-process
// test harness only. Consistent with the other module-level `.seam/` mirrors (a persistence/observability
// layer, not per-run compute state — see engine_ctx's note on why those stay module-level).
export type AdapterScope = "repo" | "shared";

const _used = new Map<string, AdapterScope>();   // name → where it was read from (repo-local beats shared)
const _learned = new Set<string>();              // names synthesized + persisted this run

export function recordAdapterUsed(name: string, scope: AdapterScope): void {
  if (!name) return;
  if (!_used.has(name) || scope === "repo") _used.set(name, scope);
}
export function recordAdapterLearned(name: string): void { if (name) _learned.add(name); }

export interface AdapterLedger { used: { name: string; scope: AdapterScope }[]; learned: string[]; }
export function ledgerSnapshot(): AdapterLedger {
  return { used: [..._used].map(([name, scope]) => ({ name, scope })), learned: [..._learned] };
}
export function resetLedger(): void { _used.clear(); _learned.clear(); }
