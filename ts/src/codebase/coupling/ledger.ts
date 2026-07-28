// Run-scoped LEDGER of the LEARNED `.seam/` adapters a run TOUCHED — which were CONSULTED (replayed offline,
// the "deterministic-forever" half) and which were NEWLY learned this run (the LLM fired once). Pure
// observability, but the observability IS the point: it makes the learned-adapter FLYWHEEL visible so a run can
// REPORT the compounding asset it used and grew, and the user can promote it (`seam-adapters`).
//
// THE CORE IS THE ONLY SOURCE. It reads the stores, so it is what knows which adapters a run replayed. This
// module used to keep its own maps beside it, fed by TypeScript store paths no product code took any more —
// which is exactly why the CLI's adapter line had gone silently empty: the flywheel kept paying off and the
// run kept reporting nothing. There is no second half left to merge.
import { loadAddon } from "../rust_core.js";

export type AdapterScope = "repo" | "shared";
export interface AdapterLedger { used: { name: string; scope: AdapterScope }[]; learned: string[] }

export function ledgerSnapshot(): AdapterLedger {
  const used: { name: string; scope: AdapterScope }[] = [];
  const learned: string[] = [];
  try {
    // `[name, scope]`, with an EMPTY scope meaning "learned this run" rather than replayed.
    for (const [name, scope] of (loadAddon()?.adapterLedger() ?? []) as string[][]) {
      if (!scope) learned.push(name); else used.push({ name, scope: scope as AdapterScope });
    }
  } catch { /* no addon → an empty ledger, which is the truth: nothing scanned, so nothing was replayed */ }
  return { used, learned };
}

export function resetLedger(): void {
  try { loadAddon()?.resetAdapterLedger(); } catch { /* no addon */ }
}
