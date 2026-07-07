# Decoupling the border from the grow — design & implementation plan

## Product goal

On a **warm / learned** repository, answering a concern must be **~milliseconds**, not minutes.
Today Acme takes ~2 min on a *warm* run because every query **re-grows** the region: it
re-discovers structure, re-resolves edges, re-materialises coupling — even though nothing changed.
That makes the product close to unusable at scale.

The fix is architectural, not another cache: **separate DISCOVERY from BORDERING.**

- **Discovery** — reading files, resolving call/import/dep edges, resolving data-coupling
  crossings, running the flywheel. Expensive, **intent-independent**, a pure function of the code.
  Paid **once** into a persistent **map**; re-paid only for files that changed.
- **Bordering (selection)** — deciding *which* of the discovered nodes are the concern's answer:
  the up-hop border, hub/ubiquity gating, the intent/relevance tier ordering, the node budget.
  **Cheap**, per-concern, pure graph math over the map.

A concern's answer becomes a **projection** (a bordered, budgeted selection) over the cached map.
Cold pays discovery once; every warm query is a projection.

## Why the first prototype diverged (and the one rule that fixes it)

The `SEAM_PROJECT` prototype proved the *idea* on private-app (warm 11–25 ms, byte-identical) but
**diverged from the grow on cal.com** (≈40%: 44 missing / 67 extra) once the region (3440 nodes) far
exceeded the budget (200). Root cause: **the projection re-implemented a *different* border** — a
plain distance-ordered BFS with no hub/ubiquity gate — instead of running the grow's *own* border
logic. When region ≫ budget the answer is an *ordering-dependent selection*, so a different ordering
picks a different 200.

> **The invariant:** there must be **exactly one** implementation of the border/selection, used by
> **both** the grow (cold) and the projection (warm). Then `project == grow` **by construction**, at
> any budget, on any repo. The prototype's mistake was having two.

So the work is not "make the projection better" — it's **extract the grow's selection into a pure
function over a graph, and have the grow call it too.**

## Target architecture

```
                    ┌─────────────────────────────────────────────┐
   source files ──► │  DISCOVERY  (expensive, intent-free, cached) │ ──► THE MAP
                    │  build_footprint + coupling, per node        │     (persistent graph:
                    │  bounded structurally, written to the map    │      nodes + typed edges
                    └─────────────────────────────────────────────┘      + per-node metadata)
                                                                              │
   concern(centers, intent, budget) ──────────────────────────────────────► │
                    ┌─────────────────────────────────────────────┐          ▼
                    │  SELECTION  (cheap, per-concern, PURE)       │ ◄──── selectConcern(map, …)
                    │  up-hop • hub/ubiquity • tier/relevance      │           the SAME function
                    │  order • node budget → the answer           │           the grow uses cold
                    └─────────────────────────────────────────────┘
                                        │
                                        ▼  intent crop / render (unchanged)
```

- **The map** is the discovered graph: `nodes`, typed `edges` (call/import/dep/interface-impl/
  route/data-coupling/type-ref), and the per-node facts selection needs (fan-in for ubiquity,
  edge kinds, ranges). Content-keyed (`_key`), persisted, incrementally extended.
- **`selectConcern(map, centers, opts)`** is the grow's border logic *lifted* to read neighbours
  from the map instead of calling `build_footprint`. Everything else — frontier ordering, tier
  rule, hub/ubiquity gate, up-hop, budget, parked-frontier — is the **same code**.
- **The grow** becomes: *discover the region into the map* → `selectConcern(map, …)`. The warm
  path skips discovery and calls `selectConcern` directly.

## The cost model (why this is viable where the prototype wasn't)

The expensive thing is **discovery** (`build_footprint` × region, coupling). It is:
- **intent-independent** → the same map serves every concern/intent on that region;
- **content-keyed & persistent** → paid once per region *ever*, re-paid only for changed files;
- **incremental** → a query discovers only the part of its region not yet mapped.

So the economics flip from *"pay discovery every query"* to *"pay discovery once, project forever."*
On a learned repo, essentially all queries are projections (ms). The first query that touches a new
region still pays that region's discovery — that cost is inherent (it's `build_footprint × nodes`)
and is what we amortise, not eliminate. Discovery can additionally be **warmed in the background /
at index time** so even first-touch is hidden.

**Bounding discovery.** The 5-min cal.com blow-up was the **unbounded DOWN-dep flood** (deps are
followed to terminals by design). Discovery must be bounded by the **structural** border only
(up-hop + hub/ubiquity — intent-free), *not* the budget and *not* intent. That region is larger than
one answer but bounded and shared; the per-node cache makes re-touch free. If a repo's structural
region is still too large, discovery is chunked and resumable (see Phase 5).

## Implementation phases

Each phase is independently shippable behind `SEAM_PROJECT` (default-off) and gated by a validation
that must pass before the next.

### Phase 1 — Extract `selectConcern` from the wave (the linchpin)
Lift the border/ordering/budget out of `_phaseExpand` into a pure `selectConcern(graph, centers,
opts)` that reads neighbours from `graph` (a nodes+edges object) rather than `build_footprint`.
Keep **all** of: frontier ordering, tier rule, hub-collapse, ubiquity gate, up-hop, node budget,
parked frontier, coupling-node handling.
- Refactor `_phaseExpand` to: (a) discover into an in-memory graph exactly as today, then (b) return
  `selectConcern(thatGraph, …)`. i.e. the grow's own answer now goes *through* `selectConcern`.
- **Gate:** the full existing suite is byte-identical (the grow's output is unchanged — we only
  routed it through the extracted function). This proves the extraction is faithful *before* the map
  exists. No new behaviour.

### Phase 2 — Discovery writes the map; warm path selects
- Discovery (the wave's `build_footprint` + coupling) writes every discovered node/edge + per-node
  facts into the persistent map (`map_store`, already sharded/epoch-keyed; extend to store the
  selection facts: fan-in, kinds, ranges).
- `projectOrGrow`: if the map covers the centers' **structural region**, call `selectConcern(map, …)`
  (warm, ms); else discover the missing region into the map, then select.
- **Gate:** on private-app AND cal.com, warm `selectConcern(map)` == cold grow **byte-identical** at the
  same budget (this is the fidelity the prototype failed — it must pass here because it's the same
  code). Warm latency ms.

### Phase 3 — Structural completeness / frontier model
- Track per node which directions were *discovered* (complete) vs the structural frontier (where
  discovery stopped). `selectConcern` never needs a node beyond the discovered region (the up-hop +
  hub border bounds it), so "map covers the region" is decidable without the converged-vs-budget
  confusion that sank the prototype.
- **Gate:** a related concern whose centers/region are already mapped selects with **zero** discovery
  (the node-level reuse), verified on private-app + cal.com.

### Phase 4 — Coupling & intent as first-class map/selection
- Coupling crossings are discovery → stored as map edges (per-file coupling cache already resolves
  them once). Intent/relevance is **selection** → `selectConcern` takes the intent field and orders/
  tiers with it, so one map answers many intents. Confirm the intent tiering matches the grow's.
- **Gate:** intent-varying concerns over one map reproduce their respective grows; coupling crossings
  present and correct.

### Phase 5 — Scale: incremental & resumable discovery on Acme
- Discovery is chunked (bounded work per call, resumable), and warmable in the background / at index
  time. Measure Acme: first-touch cost, warm projection latency, cross-concern reuse.
- **Gate:** Acme warm concern **< a few seconds** (target ms once the map is warm), faithful to the
  grow; the "2-min warm" is gone.

### Phase 6 — Wire into the CLI/MCP concern path, flip defaults
- Route the concern/`--concern` path and the MCP `grow_intent` through `projectOrGrow`.
- Re-run the cal.com + Dubbo + Acme matrix. **Flip `SEAM_PROJECT` (and its friends) default-on only
  when** warm is ms-to-seconds AND `project == grow` on all three.

## Risks & open questions

- **Extraction fidelity (Phase 1)** — the wave's ordering is entangled with discovery (e.g. hub-gate
  inspects the *accumulating* region). Extraction must preserve that. Mitigation: extract, then prove
  byte-identity on the whole suite *before* introducing the map. This is the make-or-break gate.
- **Discovery region size** — even structurally bounded, a dense repo's region may be large; hence
  incremental + background discovery (Phase 5). We amortise, not eliminate, first-touch cost.
- **Map staleness** — keyed on the coupling epoch (source ⊕ learned matchers); a changed file drops
  its shards. Same model as the existing graph cache; no retro-push (accepted tradeoff).
- **Determinism vs accumulation** — a concern's answer must not silently change as unrelated regions
  are added to the map. `selectConcern` is bounded by the concern's own border, so accumulation
  elsewhere is inert; Phase 2's byte-identity gate guards this.

## Status (living)

- **Phase 1 — DONE.** The neighbour-source seam (`coStruct.neighbors`) is in `_applyMove`; default =
  `build_footprint` (live grow byte-identical, full suite 952 pass). When set, the SAME wave reads
  the neighbourhood from a graph. `projectConcern` now **runs `_phaseExpand` over the map** through
  the seam — one border implementation, not two.
- **Phase 2 — core landed; the approach is PROVEN, one residual to close.**
  - **cal.com: BYTE-IDENTICAL** — project over the grow's own footprint = 394 ≡ 394, 0 over-grow, 0
    misses. The repo that had ~40% divergence with the hand-rolled BFS is now exact, because the
    hub/ubiquity gate applies by construction. This is the proof the decoupling is the right design.
  - **private-app: 93% with coupling / ~76% structural-only**, always **0 over-grow**. Marker nodes are
    expandable in projection mode (gated `&& !coStruct.neighbors`); wave↔splice iterates to convergence.
  - **Residual, precisely characterised** (private-app is route/table-dense; cal.com isn't — hence the split):
    (a) off-border coupling *complements* the grow auto-keeps beyond the up-hop border (a coupling-
    overlay semantics diff — likely the `coupling-overlay-bloat` the border *should* trim); (b) a handful
    of nodes from **wave-accumulation-order sensitivity** — the up-hop-reset / hub-fan computations
    depend on the exact edge-set/order the wave sees, and the map's accumulated edges differ slightly
    from `build_footprint`'s per-node resolved neighbours (an out-edge can enter the map via a *consumer's*
    up-expansion, not the node's own down-expansion), so the border coordinate lands slightly differently.
    **Next (a focused, harness-gated fidelity pass):** make those two computations *edge-set-invariant* —
    up-hop from a stored per-node depth, hub-fan from the global ubiquity index rather than the move's
    incremental `added` — and reconcile the coupling auto-keep. The live grow must stay byte-identical
    (same code), so each change is gated on the suite.

## Fidelity investigation — the residual is fully diagnosed (2026-07)

Bisecting `project(F) vs F` with each border predicate toggled isolated the divergence **entirely to the
hub gate** (up-hop and tier are edge-set-invariant; with hub off, private-app is byte-identical too):

- With **hub off** (up-hop 2 + tier on): private-app 282/283 — identical.
- With **hub on**: private-app 256/272 — the 16-node gap is 100% hub-gated fan members.

**Why the hub gate resists a simple invariant rewrite.** Its trigger (`r.added ≥ hubFan`) AND its crop
(`addedIds` = nodes NEW to the region this move) both key off *what was already accumulated*. That
accumulation-dependence is **semantically load-bearing**: the crop deliberately removes only the fan
members that are NEW (reached solely via the hub), protecting the already-established spine. Gating on the
node's *total* fan and cropping the whole fan by content-key (the "invariant" version) **cropped the spine
itself** (the center's own callers are consumers of the hub) → proj collapsed to 72 nodes. Reverted.

**Root cause, precisely.** The projection over the map diverges because `neighbors(node,dir)` reads the
map's *accumulated union* of edges, which is a **superset** of what `build_footprint(node,dir)` returned in
the grow (an out-edge can enter the map via a *consumer's* up-expansion, not the node's own down-expansion).
So the projection's accumulation ORDER differs from the grow's → the hub crop's "established spine" differs
→ different fan members are cropped.

**The clean fix (next).** Make the neighbour source *equal* `build_footprint`'s per-node output, not the map
union — either (a) source neighbours from the **P3 cache** (`build_footprint_cached`, warm = cheap disk/mem
reads, no resolution) so accumulation is byte-identical to the grow; or (b) store **per-edge provenance**
(which node's expansion in which direction discovered each edge) so `neighbors` returns exactly that node's
own footprint. Option (a) is simplest and makes `project == grow` by construction. **Caveat:** running the
full wave (even over cheap P3 reads) keeps the wave's per-wave overhead (`assign_roles` / `from_resolved_graph`
/ hub-classification recomputed each wave = O(waves·N)); getting to *milliseconds* then needs that overhead
made incremental (O(N)). So the end state is **P3-cache neighbour source (fidelity) + incremental wave
(speed)** — the two are separable and independently gated.

## THE DECISIVE CONCLUSION (2026-07) — measured, not theorised

Measuring the warm wave (P3 cache warm, P5 answer cleared → the wave re-runs over cheap cached
neighbours, byte-identical to the grow because it IS the grow):

| approach | private-app warm | cal.com warm | fidelity |
|---|---|---|---|
| flood over the map union (no wave overhead) | ~25 ms | ~25 ms | ✗ hub gate diverges |
| **wave over the P3 cache** (= the grow) | **155 ms** | **3.9 s** | ✓ **byte-identical** |

Two hard facts fall out:
1. **The border CANNOT be decoupled into a separate flood and stay faithful** — the hub gate is
   accumulation-order-dependent by design (it protects the established spine), so any traversal that
   doesn't reproduce the grow's exact accumulation diverges. Fidelity ⇒ run the wave.
2. **The wave over cached neighbours is already byte-identical and cheap on small footprints (155 ms),
   but its PER-WAVE overhead is O(waves·N)** — `from_resolved_graph` + `assign_roles` + the dist/up-hop/
   hub BFS are rebuilt from scratch every wave. On cal.com (436 nodes, ~tens of waves) that's 3.9 s; on
   Acme it is the "2 min warm". **This — not discovery — is the scaling wall.**

**So the real lever is: make the wave's per-wave overhead INCREMENTAL (O(N) total, not O(waves·N)).**
Maintain roles/distance/up-depth/hub-classification incrementally as nodes are admitted, instead of
rebuilding a `Graph` and re-running `assign_roles`/BFS each wave. This keeps the wave byte-identical
(harness-gated) and turns 3.9 s → target ~100 ms, which IS the fast+faithful warm path. Discovery stays
cached (P3, persistent). The map/projection *flood* is retired as a fidelity dead-end; its lesson —
"discovery is cached, bordering is the wave" — stands, but bordering is the SAME wave made fast, not a
separate cut.

**Recommended next work (supersedes Phases 3–6 above):** profile `_phaseExpand`'s per-wave hot spots
(likely `from_resolved_graph`+`assign_roles`), make them incremental, harness-gate byte-identity, measure
private-app/cal.com, then Acme. This also speeds the COLD grow (it pays the same per-wave overhead).

## Definition of done

`project == grow` byte-identical on private-app + cal.com + Dubbo + Acme, warm concern latency ms-to-seconds
on Acme, discovery paid once per region and incrementally, defaults flipped on.
```
