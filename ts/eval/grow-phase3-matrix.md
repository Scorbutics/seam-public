# Phase 3 — residual-band SLM (booking-mini)

The residual band partitions each ring deterministically before the SLM sees it, so the SLM judges only the
ambiguous middle:

- **auto-KEEP** — bears a materialised crossing edge / `coupling`, or intent field ≥ `hi` (default **0.34**);
- **auto-DROP** — cross-module ubiquity ≥ `fan` AND intent field ≤ `lo` (default **0.20**), no crossing (I4);
- **residual** — everything else → the SLM, exactly as before.

`hi`/`lo` are SLM-agreement-calibrated on the fixture (per-node intent score vs the SLM verdict): hi = 0.34
is the widest upper band with 100% keep-agreement (the highest SLM-DROP node, `adminService`, sits at 0.332);
lo = 0.20 auto-drops the `logger`/`db` files (100% file-level drop-agreement) while the crossing DAO (field
0.30+) is crossing-excluded anyway. Env-overridable (`SEAM_GROW_BORDER_HI/LO`); author-repo recalibration
pending. Flag `SEAM_GROW_BORDER_RESIDUAL` / `opts.borderResidual`, default OFF (I1 preserved).

## Result on the fixture

| config | precision | recall | LLM calls | auto-keep / auto-drop / slm |
|---|---|---|---|---|
| slm (full border) | 100% | 100% | 5 | — |
| **slmres (residual)** | 83–100%* | 100% | **4 (−20%)** | 2 / 1 / 7 |

\* The SLM is **non-deterministic**: `slmres` drew P 100% in one run and P 83% in another (the full `slm`
wobbles the same way). The residual band's deterministic auto-decisions are stable; the wobble is the model's
verdict on the middle band. So SLM-backed configs are **reported, not gated** in the harness — a single-run
region-precision gate against the SLM would flake. (Stable gating would need N-run aggregation as in
`coupling_harness`.)

## The ≥50% LLM-call-reduction gate is NOT met on this fixture (−20%). Why, and what it needs

The mechanism is correct (proven hermetically in `test/grow/residual_band.test.ts`: auto-KEPT/DROPPED/I4
nodes never reach the injected judge; only the middle does). But on `booking-mini` the reduction is only
20%, because:

1. **DAO crossings materialise POST-expand.** The `bookings` crossing edge is added by the P3 coupling
   overlay AFTER the wavefront finishes, so during the per-wave border the on-intent DAO nodes (`saveBooking`,
   `loadBookings`, field 0.30–0.34) sit in the *middle* band and go to the SLM every wave — they cannot
   auto-KEEP via a crossing that doesn't exist yet.
2. **The floor is too coarse to substitute.** Auto-KEEPing any file that bears a floor key (e.g. anything
   touching the `bookings` table) was tried and **reverted**: it also keeps off-intent PEER readers of the
   same table (a reporting view reading `bookings`), dropping precision 1.00→0.83. Which same-table toucher
   is on-intent is semantic — the SLM's job, not the floor's.
3. **The fixture is tiny.** With ~5 waves, the reduction is bounded by how many waves fully clear; the
   confident (crossing + shared-infra) fraction a real repo has is exactly what a 10-file fixture lacks.

**What the ≥50% gate needs:** a real repo (larger confident fraction; the author's `private-app`/monorepos are
unreachable here) — and/or moving crossing materialisation into expand so on-intent DAO nodes auto-KEEP
per-wave (a larger structural change, out of Phase 3's scope). Correctness and the mechanism are delivered;
the 50% *number* is a real-repo expectation.
