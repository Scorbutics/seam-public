# Phase 2.2 — region-centroid field matrix (booking-mini) — GO/NO-GO

The plan's decision point: does a region-centroid `blend` field beat the intent-cosine soft border, and is
it a viable deterministic replacement for the SLM? Full matrix on the hermetic fixture (fan thresholds
scaled to 3 for the tiny repo; production defaults are 12).

| config | precision | recall | nodes | llm | must-keep | must-drop | verdict |
|---|---|---|---|---|---|---|---|
| det (flood) | 50% | 100% | 14 | 0 | ✓ | ✗ (all 3) | baseline |
| **tol-intent** | 56% | 100% | 12 | 0 | ✓ | ✗ (all 3) | **best deterministic** |
| tol-blend | 44% | 80% | 11 | 0 | ✗ (dateRanges) | ✗ (all 3) | WORSE than intent |
| tol-blend + ubiquity + hub-gate | 67% | 40% | 3 | 0 | ✗ (dateRanges, bookingRepo) | ✗ (logger) | collapses |
| slm (LLM border) | 100% | 100% | 8 | 5 | ✓ | ✓ | the target |

## Verdict: NO-GO for the `blend`/`centroid` field. The intent field stays the default.

**Why the centroid field does not discriminate (measured geometry on the fixture):**

| node | intent cosine | centroid cosine | |
|---|---|---|---|
| `loadBookings` (on-intent data) | 0.302 | 0.899 | |
| `charge` (billing — off-intent) | 0.254 | **0.669** | |
| `computeFreeRanges` (on-intent) | 0.237 | 0.648 | |
| `log` (logger — off-intent) | 0.099 | **0.464** | |
| `mergeIntervals` (low-cosine MECHANISM) | 0.145 | 0.364 | |

The region centroid is close to **everything near the region** — the off-intent `charge` (0.669) and `log`
(0.464) score *higher* on the centroid than the on-intent low-cosine mechanism `mergeIntervals` (0.364). So
centroid similarity does **not** separate on-intent from off-intent; it only says "in the neighbourhood".

Worse, feeding it into the border via `blend = max(intent, centroid)` **inflates every region score**, which
RAISES the peak-relative high-water mark faster than it raises the outlier — so the low-cosine mechanism
`mergeIntervals` ends up *further* below the peak and is CUT (tol-blend drops it; recall 100%→80%). The
premise "a low-cosine mechanism is embedding-close to the kept region, so a centroid field rescues it" is
**empirically false here**: the mechanism is genuinely embedding-dissimilar, and an *absolute* centroid
floor would admit the off-intent hubs (which score higher) before it admitted the mechanism.

## Consequences for the rest of the plan

- **Phase 5 default flip** for the border field: the deterministic winner is the **intent** field, not blend.
  `SEAM_GROW_BORDER_FIELD=blend`/`centroid` stays implemented and opt-in (default `intent`), but is NOT
  recommended and is not a path to the SLM's quality.
- **Phase 2.3 (passage enrichment)** is triggered "only if blend underperforms on the low-cosine case".
  Blend underperforms — but note the **intent** field already KEEPS `mergeIntervals` on this fixture (tol =
  R 100%), so there is no local intent-field failure for enrichment to fix, and enrichment busts the entire
  embedding cache. DEFERRED: it needs a repo where the *intent* field itself cuts a low-cosine mechanism
  (the private-app/large-repo case the plan cites), which is unreachable here. Do not bust the cache without that
  evidence.
- **Phase 3 (residual-band SLM)** must derive its bands from the **intent** field (the discriminative one),
  not the centroid — and the fixture shows the deterministic priors + intent border reach at best P 63–56%
  / R 100% while the SLM reaches P 100%, so a residual band that hands the ambiguous middle to the SLM
  remains the right shape. The must-drops (`logger` directly imported; `billing`/`notifier` peer/side
  concerns) are the irreducible semantic residue no deterministic field removed.

Re-run this matrix on the author's large repos (at production thresholds) before any Phase 5 default change.
