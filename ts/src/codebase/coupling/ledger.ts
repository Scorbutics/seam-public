// Run-scoped LEDGER of the LEARNED `.seam/` adapters a run TOUCHED — which were CONSULTED (replayed
// offline, the "deterministic-forever" half) and which were NEWLY learned this run (the LLM fired once).
// Pure observability, no correctness impact: it makes the learned-adapter FLYWHEEL visible so a run can
// REPORT the compounding asset it used + grew, and the user can promote it (`seam-adapters`). The CLI
// shells out one process per analysis, so module scope == run scope; `resetLedger()` is for the in-process
// test harness only. Consistent with the other module-level `.seam/` mirrors (a persistence/observability
// layer, not per-run compute state — see engine_ctx's note on why those stay module-level).
import { loadAddon } from "../rust_core.js";

export type AdapterScope = "repo" | "shared";

const _used = new Map<string, AdapterScope>();   // name → where it was read from (repo-local beats shared)
const _learned = new Set<string>();              // names synthesized + persisted this run

export function recordAdapterUsed(name: string, scope: AdapterScope): void {
  if (!name) return;
  if (!_used.has(name) || scope === "repo") _used.set(name, scope);
}
export function recordAdapterLearned(name: string): void { if (name) _learned.add(name); }

export interface AdapterLedger { used: { name: string; scope: AdapterScope }[]; learned: string[]; }

// THE CORE IS WHAT READS THE STORE NOW, so it is what knows which adapters a run replayed. This module's own
// maps are fed only by TypeScript store paths that no product code takes any more — which is exactly why the
// CLI's adapter line had gone silently empty: the flywheel kept paying off and the run kept reporting nothing.
// Both sources are merged so a TypeScript-side record (the carrier store) still counts.
export function ledgerSnapshot(): AdapterLedger {
  const used = new Map(_used);
  const learned = new Set(_learned);
  try {
    const addon = loadAddon();
    for (const [name, scope] of (addon?.adapterLedger() ?? []) as string[][]) {
      if (!scope) { learned.add(name); continue; }
      if (!used.has(name) || scope === "repo") used.set(name, scope as AdapterScope);
    }
  } catch { /* no addon → the TypeScript half alone, as before */ }
  return { used: [...used].map(([name, scope]) => ({ name, scope })), learned: [...learned] };
}
export function resetLedger(): void { _used.clear(); _learned.clear(); try { loadAddon()?.resetAdapterLedger(); } catch { /* no addon */ } }
