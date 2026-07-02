# Phase 1 — deterministic-prior matrix (booking-mini fixture)

Grow-border region matrix on the hermetic `booking-mini` fixture. Metrics per §3 of the border-shrink
plan: region precision/recall vs the gold region, node count, LLM calls, wall. `det`/`tol` are the
offline baselines; `slm` is the LLM border (the target). `ubi`/`hub`/`hububi` are the Phase 1
deterministic priors. **Fixture note:** the fixture's max cross-module fan is ~6, so the prior configs
scale their fan threshold down to 3 to fire at all; production defaults are 12 (calibrated for real repos).

| config | precision | recall | nodes | llm | must-keep | must-drop | notes |
|---|---|---|---|---|---|---|---|
| det (flood) | 50% | 100% | 14 | 0 | ✓ | ✗ (logger, billing, notifier) | no border |
| tol (intent cosine, 0.15) | 56% | 100% | 12 | 0 | ✓ | ✗ (all 3) | embedding border too weak here |
| **ubi** (ubiquity, fan 3) | 56% | 100% | 12 | 0 | ✓ | ✗ (all 3) | drops off-intent `admin` (a hub consumer); I4-safe |
| **hub** (hub-gate, fan 3) | 63% | 100% | 11 | 0 | ✓ | ✗ (logger only) | drops the `billing`/`notifier` fans; keeps must-keeps |
| **hububi** (both, fan 3) | 67% | 40% | 3 | 0 | ✗ (dateRanges, bookingRepo) | ✗ (logger) | **UNSAFE at fan 3** — over-prunes (see below) |
| slm (LLM border) | 100% | 100% | 8 | 5 | ✓ | ✓ | the target |

## Findings

- **ubiquity (mine) is I4-safe and a modest precision gain.** At fan 3 it gates the up-climb of the
  shared `logger` hub, so the off-intent `admin` sibling (reachable only through that fan) drops. The
  crossing-bearing `bookingRepo` (ubiquity 3, but on the `bookings` crossing) is kept — the I4 contract,
  also pinned by `test/grow/ubiquity.test.ts`.
- **hub-gate alone is safe and stronger here** — it crops the `billing`/`notifier` fans, holding all
  must-keeps and recall 100%. (Pre-existing mechanism; unchanged this phase.)
- **Neither prior removes the must-drops the SLM removes** (`logger` directly imported by handler+service;
  `billing`/`notifier` peer/side concerns). Those are the SEMANTIC residue the centroid field (Phase 2)
  and the residual SLM (Phase 3) own — the priors are for *shared infrastructure*, not peer domains.
- **Stacking the priors aggressively (hububi, fan 3) OVER-PRUNES** — recall 100%→40%, severing the
  `availabilityBean → bookingRepo → dateRanges` mechanism. Root cause: the hub-gate evaluates
  spine-ward-ness *during expand*, when the coupling overlay's crossings are **not yet materialised**
  (coupling is the post-expand P3 phase), so a data-layer fan reads as non-crossing; ubiquity's
  reordering tips the gate into cropping it. It is a threshold-and-interaction artifact, **not** an I4
  violation in ubiquity (`ubi` alone keeps `bookingRepo`; `hububi` at fan 6 is the full region again).
  → **Watch-item for Phase 2.2's combined `tol-blend + ubiquity + hub-gate` config:** keep thresholds at
  the production defaults (12) or gate the priors behind the materialised-crossing set, don't stack
  aggressively.

## Default-flip decision (plan 1.2): DEFERRED — do not flip `hubGate` default

The plan conditions flipping `hubGate`'s default ON in wave mode on the priors holding the §3 gate
"versus the `slm` baseline's must-drops" across the fixture **and the author cases**. On this fixture:
- at the production default fan (12) the priors do not fire at all (the fixture's fan tops out at ~6),
  so the fixture cannot validate the *default* behaviour;
- the author-local eval repos (`~/dev/private-app`, large monorepos) where the 62%-off-intent hub
  overgrow was measured are **unreachable in this environment**.

With no evidence at production thresholds and the author repos unavailable, flipping a production default
would be unjustified. `SEAM_HUB_GATE` / `opts.hubGate` and `SEAM_UBIQUITY` / `opts.ubiquity` stay **opt-in
(default OFF)**; the escape hatch is moot until the default flips. Re-run this matrix on the author repos
(at default thresholds) to make the flip decision.
