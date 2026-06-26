# P3 coupling strategy — design

> The grow's **P3** phase (docs/grow-architecture.md) finds cross-boundary data-flow bridges. This doc is
> about P3's **internals**. Decision (Brice): **keep every feature and the cache; redraw boundaries only; do
> not impact performance.** An earlier draft proposed removing the flywheel — that was wrong; see the impact
> analysis below.

## Do NOT remove the flywheel — impact analysis

Discovering a coupling is easy (the LLM is great at it). The flywheel — constrained-IR adapter + self-
validation loop + matcher store — looks like "extra machinery", but removing it costs exactly what we must
not spend:

1. **Performance.** The matcher store is a CACHE: warm runs replay learned adapters at **0 LLM calls**.
   Remove it → every run re-pays the LLM. The engine is already slow; this makes it slower. Disqualifying.
2. **Features.** Lose learned custom adapters (data layers the floor can't match), cross-framework synthesis,
   the self-validation harness (guarantees a learned adapter actually grounds — reliability), and determinism.
3. **Capitalisation.** The flywheel IS "capitalise on the LLM passes" — learn once, reuse forever via the
   cache. Removing it re-does the LLM work every run.

So the LLM passes + cache stay. The work is **boundaries, not strategy**.

## The principle, applied inside P3

The grow's problem was that coupling had no *boundary* (it ran inside the traversal). The decoupling fixed
the big one. The same discipline applies *within* P3: name its layers as clean, contracted components so each
is reasoned about and tuned in isolation — **with zero behaviour / feature / perf change.**

```
P3 coupling
├─ FLOOR      deterministic adapters (Supabase/.from, member-access ORM, http_route, annotation) + carrier trace
├─ LEARN      the flywheel — LLM synth → self-validate → IR adapter        [the LLM passes]
├─ GROUND     literal co-occurrence (a key is real only if both sides name it)
├─ APPLY      run adapters (floor ∪ learned) over the footprint → bridges
└─ CACHE      .seam matcher store — warm-free replay                       [the capitalisation]
```

These exist in `coupling/` today; they are just not drawn as contracts. Drawing them means: a function
boundary + a typed in/out + a behaviour pin per layer — exactly the grow phase extraction, one level down.

### Why this is what's wanted

- **Granularity becomes one knob in one place.** Coupling cost scales with how many LLM calls LEARN makes;
  that is set by its **clustering coarseness** (the "300 files → 15 shapes" lever). With LEARN behind a
  boundary, coarseness is tuned there — measured, before/after — without touching FLOOR / GROUND / APPLY.
- **A coupling bug is localisable.** "wrong key" → GROUND; "missed a custom adapter" → LEARN; "the `String`
  complement mislabel" → APPLY (complement_unit). Same payoff as the grow phases.
- **No regression risk.** Behaviour-preserving extraction, pinned. Nothing about discovery, the cache, or the
  cost changes.

## Migration — boundaries only, behaviour-pinned

1. **Pin** current coupling grounding on the fixtures: a P3 oracle of *keys produced/consumed per case* AND
   *LLM call count* (so "identical recall + identical calls" — no silent feature/perf change — is provable).
2. **Extract** FLOOR / LEARN / GROUND / APPLY / CACHE as named functions behind typed contracts, behaviour-
   preserving, validated against step 1. No strategy change.
3. **Stop.** Granularity tuning is a *separate, later, measured* step inside the LEARN boundary — not part of
   the boundary draw.

## Explicitly NOT doing

- Not removing or demoting the flywheel.
- Not changing which LLM passes run, or when, or how many (that is the perf step, done later, measured).
- Not changing the floor adapters or grounding.
