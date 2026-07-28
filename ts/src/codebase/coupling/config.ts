// COUPLING tunables, READ FROM THE CORE. `seam-couple` is what applies them — it damps a hub key, it caps the
// complements it materialises — so the shell must not carry its own copy of the numbers. It used to: the same
// literals and the same env-var defaults were written on both sides, which is a drift waiting to happen, and
// the one that matters is `hubFan`. The render EXCLUDES crossings the coupling damped as over-fanned; if the
// two disagree about the threshold, it excludes a different set than the one that was actually damped.
//
// The budget fields that used to live here (keyBudget/synthBudget/complementBudget/candidateScanBudget) are
// gone: nothing decremented them any more, the core owns those budgets, and `SEAM_KEY_BUDGET` is now read
// where it is APPLIED rather than parsed here into an object no call site passed on — which is why setting it
// had stopped doing anything at all.
import { loadAddon } from "../rust_core.js";

const _read = (): Record<string, number> => {
  try {
    const rows = (loadAddon()?.couplingTunables() ?? []) as string[][];
    return Object.fromEntries(rows.map(([k, v]) => [k, Number(v)]));
  } catch { return {}; }
};

// Memoised per process. The fallbacks are the core's own defaults, used only when there is no addon at all —
// they are not a second source of truth, they are what an engine-less shell prints.
let _t: Record<string, number> | null = null;
const t = (): Record<string, number> => (_t ??= _read());

export const COUPLING = {
  // max complement nodes materialized per shared key
  get readerCap(): number { return t().readerCap ?? 6; },
  // HUB DAMPING: a key whose far-side fan-in (distinct complement files) exceeds this is INFRASTRUCTURE, not a
  // domain channel — a shared EntityManager / session / audit log touched by half the codebase. Coupling on it
  // is generic noise that floods (and, through grow re-anchoring, COMPOUNDS) the footprint, so it materialises
  // only `hubReaderCap` complement(s); the rest is recorded as the shared-key-fanout blindspot (honest, not
  // silent). Structural (degree), not a name match. $SEAM_COUPLING_HUB_FAN.
  get hubFan(): number { return t().hubFan ?? 16; },
  get hubReaderCap(): number { return t().hubReaderCap ?? 1; },
  // max shared keys ONE node surfaces — caps a hub file emitting dozens of UI events, keeping the most
  // specific. $SEAM_NODE_KEY_CAP.
  get nodeKeyCap(): number { return t().nodeKeyCap ?? 16; },
};
