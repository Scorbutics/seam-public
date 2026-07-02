# booking-mini — a hermetic grow-border fixture

A tiny in-repo TypeScript "app" that reproduces, in miniature, the three border shapes the wave-grow
intent border must tell apart. Driven by `ts/eval/grow_harness.ts` (case `booking-mini`), it lets the
grow-border eval run **fully offline** (no author-local repo, no network) — the model for CI.

**Intent under test:** *"how does a member book a slot and confirm availability"*
**Anchor:** `api/bookingHandler.ts` → `createBooking`.

## The mechanism spine (gold region — must be KEPT)

```
createBooking (api/bookingHandler.ts)
  └─ bookSlot (services/bookingService.ts)
       ├─ AvailabilityBean.computeFreeRanges (domain/availabilityBean.ts)   ← availability mechanism
       │    ├─ mergeIntervals (util/dateRanges.ts)                          ← LOW-COSINE mechanism
       │    └─ loadBookings  (data/bookingRepo.ts)                          ← data layer
       └─ saveBooking (data/bookingRepo.ts)  ──db-table:bookings──▶  the crossing
```

`goldRegion` = { bookingHandler, bookingService, availabilityBean, bookingRepo, dateRanges }.

## The adversarial cases

- **low-cosine mechanism** (`util/dateRanges.ts` `mergeIntervals`) — pure interval math, shares no
  vocabulary with "booking"/"availability", yet it IS the availability computation. A pure-embedding
  intent border scores it near-zero and cuts it. **must-keep.**
- **spine hub with a crossing** (`data/bookingRepo.ts`) — writes the `bookings` table (the flow's
  grounded db-table crossing) AND is consumed cross-module by `reporting/` (reads `bookings`) and
  `admin/` (calls `loadBookings`). High consumer fan-in → the ubiquity/hub-gate false-positive trap;
  because it bears the crossing, invariant **I4** forbids any deterministic gate from dropping it.
  **must-keep.**
- **peer-domain departure** (`billing/billingService.ts` `charge`) — a sibling domain reached by ONE
  call from `bookSlot`, writing its own `invoices` table. **must-drop.**
- **shared high-fan util** (`util/logger.ts`) — imported by nearly every module; a side-concern the
  flow passes THROUGH, not one it is ABOUT. **must-drop.**
- **side-concern** (`notifications/notifier.ts`) — triggered by `bookSlot`, not part of the flow.
  **must-drop.**

## Notes / deferred

- The peer-domain departure (`billing`) is reached over a plain **call edge**, not a queue crossing.
  A queue/event crossing (the richer form named in the plan) would additionally exercise the I4
  tension "structure cannot drop a crossing-bearer, only the semantic border can" for the departure;
  it needs an event-adapter shape and is left as an enrichment. The `bookings` db-table crossing on
  the spine hub already exercises that tension on the must-KEEP side.
- The `.from('table').verb(...)` shape (Supabase/PostgREST) is what the deterministic db-table floor
  recognises, so the `bookings` crossing is grounded with no LLM and no network.
