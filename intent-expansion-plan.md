# Intent-Oriented Expansion — implementation plan

> The interaction shifts from **"anchor → dump every seam"** to **"a question → one focused intent
> that you grow."** The typed question persists and orients selection + direction; an intent is a
> subgraph that EXPANDS along chosen links/boundaries, RECOMPUTES as it widens, and DISCARDS the
> off-intent seams. Two drivers, one engine: manual (user picks edges) and LLM-directional (the LLM
> picks the seam + the direction). Crossing layer boundaries is allowed via **SUGGESTED** edges —
> honest assumptions, always displayed marked. This is mostly **orchestration of existing pieces.**

## 0. The problem with what's built

- The fuzzy entry (`analyzeFromIntent`) drops the question after the anchor pick and renders *all*
  seams with no goal. "How are roles saved?" should focus the saving-related seam and grow it.
- One anchor is too narrow: a real intent spans layers (controller → service → repository → DB).
- Re-anchor/drill (planned, not built) is the seed of expansion — but undirected and intent-blind.

## 1. What already exists (the orchestration substrate)

| piece | where | role in this feature |
|---|---|---|
| usage-first discovery (single / module / class, depth-2 boundary) | `src/import_scan.py` | the UPWARD scan (who uses the anchor) |
| decompose → roles + intent-seams (co-occurrence floor + LLM-refine) | `src/codebase.py` | turn a footprint into labeled seams |
| LLM facade (`run_pass`, thinking=0, degrade) | `src/llm.py` | the proposed-partition / selection passes |
| SUGGESTED overlay (blindspots, non-resolved, marked) | `graph_ir`/`codebase` | the boundary-crossing assumptions |
| anchor ranking | `src/anchor_rank.py` | fuzzy entry candidates |
| native tree + decorations; Cytoscape graph | extension; `report.html` | rendering the focused/expandable graph |

**Gaps this plan fills:** scans build FRESH graphs (no merge/accumulate); the question is never
threaded; discovery is usage-first only (no DOWNWARD/dependency direction); no session/focus state;
SUGGESTED is a *flag*, not a traversable *crossing*; node ids are per-scan (`n1`), not global.

## 2. The carrying invariant (unchanged)

RESOLVED (bears the completeness promise) vs SUGGESTED (an assumption that *can* lie). Expansion
walks RESOLVED edges where they exist and crosses boundaries via SUGGESTED where they don't. The
completeness promise holds only over the resolved sub-graph; every SUGGESTED crossing is rendered as
an explicit assumption (the existing dashed/"suggested" affordance). Brice's rule: crossing layers
this way is acceptable *because* the end graph shows the assumptions — `assert_resolved_only` still
guards the resolved adjacency; SUGGESTED crossings live in their own overlay, never unioned in.

## 3. Core engine: the Intent Session

One stateful object both drivers operate on (extension-held; Python is stateless per call):

```
IntentSession = {
  intent: string,                  // the persisted question — orients selection + direction
  anchor: {symbol, file, kind},    // the confirmed seed (fuzzy ramp or cursor)
  graph: ResolvedGraph,            // ACCUMULATING — merged across expansions, global node ids
  focus: seamId,                   // the one intent being grown (others collapsed, not deleted)
  history: Expansion[],            // for undo / provenance of how the footprint grew
}
```

Operations (each = orchestration of existing pieces + a small new bit):
- **seed(intent)** → anchor_rank candidates → user confirms → scan → decompose → **selectSeam**.
- **selectSeam(intent)** → LLM picks the seam(s) matching the question → set `focus`, collapse rest.
- **expand(node, direction)** → scan from `node` in `direction` → **merge** into `graph` →
  recompute decompose over the union (the "intent recomputed") → keep `focus` lineage.
- **crossBoundary(node)** → when resolved expansion is exhausted, add SUGGESTED crossing edge(s).

Manual driver = the user triggers expand/cross on a clicked node. LLM driver = the LLM chooses the
node + direction (§5). **Same engine — do not build two.**

## 4. New capabilities (size noted)

- **A. Intent threading** *(cheap)* — carry `intent` in the session + pass it to the LLM passes.
- **B. LLM seam-selection — FUSED into the refine pass** *(preferred; measured)* — the existing
  `refine_seams_llm` prompt ALREADY carries the carriers, labels, and consumer-usage. Rather than a
  second round-trip, EXTEND that one prompt to also take the intent and mark the best-matching seam
  → ONE pass returns both the labeled partition AND the selection (Brice's optimisation: saves the
  ~8s + the re-sent context). When there is no intent (plain anchor analysis) the prompt skips the
  selection ask, so that path is unchanged. **Gate (measure before trusting):** (1) the partition
  quality is unchanged vs today (the harness already scores it, direct before/after); (2) selection
  accuracy matches a dedicated pass (small intent→expected-seam eval). Fall back to a SEPARATE
  selection pass only if fusing degrades either. PROPOSED (can't lie; removing it leaves all seams).
- **C. Graph merge + global node identity** *(medium)* — switch node ids from per-scan `n1` to a
  STABLE key (`file#symbol#startLine`) so a symbol scanned from two anchors dedups. A `merge(g1, g2)`
  that unions nodes/edges/blindspots. Recompute decompose over the union. **Migration:** the harness
  golds key by id → update golds to stable ids (or add an id-map). Deterministic, fully testable.
- **D. Downward (dependency) direction** *(new, symmetric, cheapish)* — parse the anchor's OWN
  imports → resolve each via the existing `resolve_module` → dependency nodes (RESOLVED if a direct
  import, SUGGESTED if DI/dynamic). This is the "service → repository → DB" direction. Reconciles
  with the usage-first decision: usage-first stays the DEFAULT discovery; DOWNWARD is an EXPANSION
  option the intent/direction chooses — not the default.
- **E. Boundary-crossing as a traversable SUGGESTED edge** *(medium)* — today a blindspot is a flag;
  here it becomes a crossing the expansion can FOLLOW (symbol-match: "this service name appears as a
  field/param in a controller"; or LLM: "this layer is wired to that one"). Provenance SUGGESTED,
  rendered as an assumption, never in the resolved adjacency. Extends the existing blindspot overlay.
- **F. LLM direction-pick** *(new pass)* — given the focused seam + question + the available
  outgoing handles (links, boundary, dependency candidates), choose which to expand and which way.
  PROPOSED. The adaptive "controller→service+DB vs service→controller" logic lives here.
- **G. Session state + focused/expandable rendering** *(extension, F5)* — hold the session; render
  the focused seam with its expansions; clicked links/boundary are the expansion handles; SUGGESTED
  crossings rendered distinct (reuse the boundary/`SUGGESTED` affordance).

## 5. Phasing (each independently shippable + green-gated)

**Phase 1 — Intent threading + FUSED seam-select (the polish fix).** (A + B)
Thread the question through the session; the refine pass (fused, §4B) labels the seams AND marks the
one matching the question; the renderer leads with it and collapses the rest. "How are roles saved?"
→ focus the save/persist seam. *Fixes the goal-less dump immediately, no new traversal, no extra LLM
round-trip.* Gate: (1) fusing doesn't degrade the partition (harness before/after); (2) selection
reliably matches the question (PROPOSED + stability; small eval + F5).

**Phase 2 — Manual expansion + graph merge + focus (the expand-seam core, upward).** (C)
Click a link/boundary → re-scan from it → MERGE → recompute → grow the focused intent; other seams
collapse. "Add more edges" = repeat. This is re-anchor/drill, generalized + intent-kept. Gate:
nodes dedup correctly on merge (deterministic, testable).

**Phase 3 — Downward (dependency) expansion.** (D)
Expand toward what the anchor USES (service → repo → DB), via the anchor's resolved imports.
Direction becomes a choice (up = consumers, down = dependencies). Gate: do imports resolve to the
intended layer (RESOLVED vs SUGGESTED rate)?

**Phase 4 — Boundary-crossing via SUGGESTED.** (E)
When resolved expansion is exhausted at a layer seam, offer SUGGESTED crossing edges (symbol-match
first, LLM second) so the intent can continue across DI/ORM/dynamic — marked as assumptions. Gate:
do crossings land in the right layer often enough to be useful *as assumptions* (honest, but does it
help)?

**Phase 5 — LLM-directional auto-orchestration (the automatic mode).** (F + orchestration)
question → confirm anchor → decompose → LLM-select-seam → LLM-pick-direction → auto-expand (Phases
2–4) until the question is covered → render. The "less precise, automatic" path. Gate (the big one):
does the auto-grown graph answer "How are roles saved?" better than the flat dump / a raw LLM? This
is the §6 wow test, now concrete.

**Phase 6 — Session state + focused/expandable rendering (extension).** (G)
Hold the session across expansions; render focus + handles + suggested crossings; undo via history.

## 6. Load-bearing assumptions to validate (gates, pre-registered)

1. **Seam-selection accuracy (P1):** the LLM picks the question's seam in ≥X of trials, stable. If
   not, the question can't orient — rethink before expanding.
2. **Merge identity (P2):** a symbol reached from two anchors dedups to one node (no dup, no false
   merge). Deterministic — measure on a fixture.
3. **Downward resolution (P3):** anchor imports resolve to the dependency layer at a useful rate;
   the rest honestly SUGGESTED.
4. **Crossing usefulness (P4):** SUGGESTED layer-crossings land in the right neighbour often enough
   to be worth offering as assumptions (not noise).
5. **Direction quality (P5):** the LLM expands toward the answer, not sideways.
6. **THE wow gate (P5):** the focused, expanded, intent-oriented graph answers the question better
   than today's dump or a well-prompted LLM. Pre-registered, Brice judges.

## 7. Challenges / decisions flagged

- **Don't reintroduce dependency-direction as the default.** History: an early version mapped what
  the anchor USES (its imports / outgoing calls — "downward"); Brice corrected it to USAGE-FIRST
  (who uses the anchor — the blast radius) and had the dependency direction removed. §4D's downward
  expansion IS that direction, needed to reach a service's DB layer. The guardrail (not a reversal):
  usage-first stays the DEFAULT SEED; downward is an EXPANSION the intent explicitly chooses, never
  the default. So the initial decomposition is still usage-first; only a directed expansion goes
  down. (§4D)
- **One engine, two drivers.** Build seed/select/expand/cross once; manual = user triggers, LLM =
  model triggers. Resist forking.
- **Global node ids** touch the harness golds — plan the id migration with Phase 2.
- **LLM budget:** selection + direction add passes; honor the 2-min ceiling, keep each focused,
  cache per session (the same graph is re-decomposed on expand — cache the LLM labels).
- **Focus = collapse, not delete** (reversible; supports undo/"add more edges").
- **Where the session lives:** extension state (the renderer is stateful); Python stays stateless
  per call, taking the accumulating graph in and the recomputed model out. Keeps D1/D6 intact.

## 8. Recommended first cut

Phase 1 alone (intent threading + LLM seam-selection) is cheap, mostly orchestration, and directly
kills the "goal-less dump" complaint — ship it first and F5 whether the focus reads right. Then
Phase 2 (manual expand + merge) gives the interactive growth. Phases 3–5 add downward + crossings +
the automatic driver once the manual loop proves the model.
