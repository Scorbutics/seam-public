// Seam-assembly / RENDER tunables, READ FROM THE CORE. `seam_decompose::config` is what APPLIES them — it
// caps the terminals it promotes, it decides a policy by consumer count — so the shell must not carry its
// own copy of the numbers.
//
// It used to: the same five literals were written on both sides. The one that bites is `offCap`. The engine
// collapses OFF-tier seams past it and a renderer decides what to show by the same threshold; if the two
// disagree, the renderer shows a different set than the one that was actually collapsed. Same shape of bug
// as the coupling `hubFan` drift (see coupling/config.ts) — a cap and its reader must be one number.
//
// All five come from the core even though only three are read by ported passes today. Sourcing half here and
// half there is the drift itself, just deferred.
import { loadAddon } from "./rust_core.js";

const _read = (): Record<string, number> => {
  try {
    const rows = (loadAddon()?.renderTunables() ?? []) as string[][];
    return Object.fromEntries(rows.map(([k, v]) => [k, Number(v)]));
  } catch { return {}; }
};

// Memoised per process. The fallbacks are the core's own defaults, used only when there is no addon at all —
// they are not a second source of truth, they are what an engine-less shell prints.
let _t: Record<string, number> | null = null;
const t = (): Record<string, number> => (_t ??= _read());

export const RENDER = {
  // a seam with more inline call-sites than this is a guard/policy fan → cap + summarize
  get fanCap(): number { return t().fanCap ?? 8; },
  // max OFF-tier seams shown before collapsing the rest
  get offCap(): number { return t().offCap ?? 8; },
  // max terminals surfaced
  get terminalCap(): number { return t().terminalCap ?? 12; },
  // max blindspots emitted
  get blindspotCap(): number { return t().blindspotCap ?? 50; },
  // a wide import-only fan with >= this many consumers reads as a policy, not a flow
  get policyMinConsumers(): number { return t().policyMinConsumers ?? 8; },
};
