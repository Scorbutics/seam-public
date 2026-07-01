# Grow architecture — the contract

> Status: **target architecture + migration**. This file is the contract the grow is being stabilised
> against. Change the code to match this doc, not the other way around. When a behaviour question comes up,
> the answer lives in exactly one phase below — if it doesn't, the phase boundaries are wrong, fix *those*.

## Why this exists

The codebase-mode grow (`src/codebase/grow/orchestrate.ts`) accreted into **one function** doing seed +
structural expansion + data-coupling + intent ranking + direction + pruning + budget. Every fix edited that
one function, so every fix could move everything, and we couldn't tell whether a bad footprint was the
*grow's* fault or the *coupling's*. The result was a sequence of quick fixes that each disturbed the whole.

The cure is **internal seams**: phases with a single concern and a stable contract, so a problem is
localisable to one phase and fixable there without touching the others.

## The one principle

**Discover for connectivity; prune by intent.**

Discovery (reaching the flow's terminals) and relevance (what matters to the question) are different
concerns. Mixing them in one greedy, intent-ranked frontier is the root of three separate bugs we hit:

- the **hub fan** — an off-intent shared key dominated the frontier;
- the **pathfinding starvation** — a high-intent terminal behind a low-intent transit was never reached
  (proven: greedy intent-first misses the UI under a tight budget);
- the **data-model descent** — `BookingData → MemberBooking → User`, on-intent *by name*, was followed.

When discovery and relevance are split, each of these becomes a one-phase fix: a connectivity bound (P2), a
prune rule (P4), a coupling cap (P3) — none of them touching the others.

## The phases

Each phase is a pure function `Footprint → Footprint` (plus read-only repo access). Each is independently
testable and independently fixable. The `Footprint` is the contract object passed between them.

| Phase | Concern | MUST NOT |
| --- | --- | --- |
| **P1 Anchor** | resolve an intent (or an explicit symbol) to a root node | — |
| **P2 Structural expansion** | reach the flow's terminals via call / consumer / dependency edges, bounded by budget. Intent may *guide* the order; it must not *prune*. | run data-coupling; drop a node for being off-intent |
| **P3 Coupling bridges** | add cross-boundary data-flow links (shared key / route) over the footprint's nodes, bounded (fan-in cap). A bridge may be *chained* one structural hop. | re-enter P2's open-ended traversal; compound by re-coupling each bridge |
| **P4 Relevance & prune** | rank by intent; drop off-intent dead ends, tests, hub crowds, data-model type chains | discover anything new |
| **P5 Decompose / render** | cluster into seams, tier by intent, present | change the footprint's membership |

### Contract notes per phase

- **P2 is intent-GUIDED, not intent-PRUNED.** It may order the frontier by relevance (cheaper to reach the
  answer first), but it may not *exclude* a node for low intent — that would starve a transit to a
  high-intent terminal. Connectivity bounds (budget, flood guard, direction policy) are P2's only limits.
  - Direction policy (P2): seed UP (consumers — the flow toward terminals). Add DOWN (deps) only for a true
    **entry point** (no in-repo consumers). A mid-flow method climbs; it does not descend its dep tree.
- **P3 is an overlay, not an ingredient.** Coupling is computed once over the settled structural footprint
  and merged; expanding a bridge uses **structural** builds only, so it chains without re-coupling. This is
  the decoupling — the grow traversal never triggers coupling.
  - *Merge by CONTENT, not id.* The overlay is deep-fanned over several files (seed / reached-resource fan),
    and `_chain_route_consumers` re-derives the SAME route→consumer crossing each time a file sharing that
    route is coupled. `_mergeCouplingOverlay` therefore dedups by `_key` (file#line#kind) exactly like
    `merge_resolved` — a re-derived crossing reuses the existing node (edges remap onto it) instead of
    re-appending under a fresh `dc` id. Without this a single crossing surfaced 12–18× → one node per re-derive
    seam (booking-app: 73 "seams" for 18 locations).
  - *Open decision (Step 2):* scope = anchor-only (today) vs every footprint node (target, more complete).
- **P4 is where intent decides membership.** Tests off by default; `--exclude` folders; hub-crowd demotion;
  data-model type-chain pruning; off-intent dead-end trimming. Everything that "removes noise" lives here,
  nowhere else.
  - *The wave SLM intent-border is REGION-SHAPED.* `_llmPruneInShape` judges each candidate NOT in isolation
    ("is this on the intent?" — which reads a data-layer bean as "generic → exclude" and severs the mechanism
    the flow delegates to) but WITH its flood REACH CONTEXT: `_reachPhrases` names which in-region node reached
    it and via what resolved relation (called by / used by / via route from), so the cheap model answers the
    region question — "does this CONTINUE the flooded concern or DEPART into a side-concern (rendering / audit /
    notifications / …)?". SLM-first: a structural auto-keep of any resolved-call continuation was tried and
    reverted (it re-admits an off-intent chain reached by the same edges — the split is irreducibly semantic).

## Current state vs target (2026-06-26)

| Concern | Today | Target |
| --- | --- | --- |
| Coupling ↔ grow | **Decoupled** — structural walk + one anchor overlay (`_anchorCouplingDelta`) | P3 overlay over **all** footprint nodes |
| Discovery vs relevance | **Split (Step 2 #1)** — P2 frontier is CONNECTIVITY-first (crossings), intent only a secondary guide that can't prune a crossing; authoritative intent ranking is P4 (decompose tiers). The hub fan that justified intent-first is capped in P3. | done |
| Direction | up-default + entry-point down | same (P2 policy) |
| Tests / `--exclude` | pruned during the walk (`_excludedFile`) | P4 rule |
| Hub fan | fan-in cap in the coupling materialiser | P3 cap (same place, named) |
| Phase boundaries | one `grow_to_terminals` function | named phase functions behind `Footprint` |

The big remaining tangle is **discovery vs relevance**: intent ranking lives in P2's frontier today, which
is what makes the pathfinding starvation possible. Moving it to P4 is the change that closes the loop — but
it is a behaviour change and comes *after* the seams exist and behaviour is pinned.

## Migration — stabilise, don't disturb

0. **Pin** current behaviour with golden footprint tests on fixtures (`test/grow/grow_contract.test.ts`), so
   no refactor can silently drift. *(The discipline that was missing — a "refactor" already changed coupling
   scope undetected.)*
1. **Extract** the phases as named functions behind `Footprint`, **behaviour-preserving**, validated against
   Step 0. No tuning. This builds the seams.
2. **Tune one phase at a time**, each change validated against its contract + the golden tests:
   - move intent ranking P2 → P4 (close the discover/prune split);
   - P3 scope anchor-only → all-nodes;
   - P4 prune rules (data-model, off-intent dead ends) as explicit, named rules.

Rule of thumb going forward: **no edit to the grow that isn't attributable to a single phase**, and no
behaviour change without a golden-test diff that is reviewed on purpose.
