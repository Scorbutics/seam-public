// L3 (the PER-ANCHOR LLM key probe, anchorProposedKeys / `discover-keys-batch`) is DEFAULT-OFF on a footprint
// grow. On a footprint grow L2 — the matcher flywheel (footprint-scoped, clustered, cached, deterministic) —
// already covers the couplings, so the per-node L3 probe is redundant: measured on cal.com it grounded 0–1
// UNIQUE couplings (the lone hit a test-scaffolding file) for ~40–100s of cold sonnet, and it churned warm
// (the wave frontier varies run-to-run → never cache-settles). Contract:
//   · footprint grow, DEFAULT          → NO per-anchor probe (relies on L1 floor + L2 matcher rules)
//   · footprint grow, SEAM_ANCHOR_KEYS=1 → probe fires, but stays BOUND to ctx.footprintFiles (opt-in, warm-safe)
//   · NON-footprint single-anchor grow → probe fires unconditionally (no L2 footprint pass; implicit-key recall)
import { describe, test } from "bun:test";

// KNOWN GAP — two of them at once, and neither is a regression:
//
//  1. The per-anchor L3 probe is NOT in the core. In TypeScript it hung off `resolveCoupling` and fired only
//     when `ctx.footprintFiles` was unset; the Rust middle drives the flywheel UP FRONT from the footprint
//     driver, which always sets it. Porting a branch its only caller cannot reach would have been porting an
//     untestable claim, so `seam_couple::gate` stops at the deterministic signals.
//  2. Counting probe calls needs an injected HostBus, and `crates/seam-llm` serves a pass only by spawning a
//     local claude/copilot binary — no host-bus bridge (see llm_key_index.test.ts).
//
// The CONTRACT below is still the one we want, and the part of it that survived IS enforced: the
// SEAM_ANCHOR_KEYS=1 bypass is ported and covered by the gate. What is unenforced is the probe's own
// firing rule. Restoring these needs the host-bus bridge first, then the probe.
describe("anchor probe — footprint scoping (L3 default-off)", () => {
  test.todo("DEFAULT footprint grow → NO per-anchor L3 probe (L1 floor + L2 matcher rules only)", () => {});
  test.todo("SEAM_ANCHOR_KEYS=1 → the per-anchor probe fires (opt-in), bounded to the footprint", () => {});
  test.todo("SEAM_ANCHOR_KEYS=1 but anchor OUTSIDE the footprint → still no probe (stays bounded, warm-safe)", () => {});
  test.todo("NON-footprint single-anchor grow → probe fires unconditionally (implicit-key recall preserved)", () => {});
});
