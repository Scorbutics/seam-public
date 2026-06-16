# Plan — Transitive re-export resolution in the consumer graph

Status: PROPOSED (2026-06-16). Unblocks the last layer of #2 (embedding anchor recall): barrel-wired
symbols currently grow only to the barrel, so they probe near-isolated and embed recall can't translate
to a usable anchor. Scope: the consumer graph (`scan_consumers` / `build_consumers_graph`). Dependency /
bidirectional graphs are a follow-up.

## 1. The exact problem (private-app, verified)

```
pairHistoryScorer.ts            defines  PairHistoryScorer
  ← scorers/index.ts            export { PairHistoryScorer } from './pairHistoryScorer.ts'   (barrel B1)
      ← missionEngine.ts        import { PairHistoryScorer } from './scorers/index.ts'        (real user)
      ← scoring/src/index.ts    export { … } from './services/scorers/index.ts'               (barrel B2 — a CHAIN)
          ← (B2's importers)    the real users one more hop out
```

`scan_consumers(anchor=pairHistoryScorer.ts, symbol=PairHistoryScorer)` (consumers.ts:85) finds a file
only when its import of `PairHistoryScorer` **resolves to the anchor file**. The real users import it from
the **barrel** (resolves to `scorers/index.ts`, not the anchor) → they're missed. Only B1 is found (its
re-export, now parsed, resolves to the anchor). So reach = 1 → still "isolated" → dropped → embed recall
wasted. (The `export…from` *parsing* shipped in 38456bd; this plan adds the *traversal*.)

## 2. The fix — close over re-export edges, following the SAME symbol

When a consumer is a **barrel** (it RE-EXPORTS the anchor symbol rather than using it), the real consumers
are the files importing that symbol *from the barrel*. So: treat a re-export hop as **transparent** —
keep searching for the symbol from the barrel, transitively, until non-re-export importers are reached.
Those are the true consumers of the anchor.

- **Rename-aware:** `export { X as Y } from './x'` re-exports `X` (from the def) as `Y` (outward). The
  next hop must search for **`Y`** from the barrel. The parser already captures `orig`/`local` (`X`/`Y`);
  the closure follows `local` outward.
- **Chains:** B1 → B2 → … — a BFS over re-export edges, `(symbol, file)` visited-set as the cycle guard.
- **Transparent depth:** re-export hops do NOT consume the user-facing `depth` budget (they're the same
  symbol, merely rerouted). Only a *real* consumer counts as a depth step.

## 3. Implementation

1. **Tag re-exports in the parser** (`typescript.ts`): `ImportRef.reexport?: boolean` — set on the
   `_REEXPORT_RE` refs (a one-line addition to the `emit` path; the parsing already exists).
2. **`scan_consumers` carries the flag** (consumers.ts): `Consumer.reexport?: boolean`, set when the
   matched ref is a re-export.
3. **Re-export closure** (in `scan_consumers` or a wrapper it calls): after finding direct consumers of
   `(symbol, anchor)`, for each that is a `reexport` barrel B, recurse `scan_consumers(B, outwardName)`
   and fold the results in as consumers of the anchor (status `resolved`, provenance noting the barrel
   hop). Visited-set on `(file, name)`; bound the hop count (e.g. ≤ 5) as a runaway guard.
4. `build_consumers_graph` consumes the (now transitive) consumer list unchanged — the closure is internal
   to consumer-finding, so depth/bidirectional logic is untouched.

## 4. Validation

- **Unit (portable):** a fixture barrel (`index.ts` re-exporting a def) + a consumer importing via the
  barrel → `scan_consumers(def)` returns the consumer (resolved, through the barrel); a renamed re-export
  and a 2-hop chain covered. Add to a `consumers`/`reexport` test.
- **Live (private-app):** anchoring on `PairHistoryScorer` grows past reach 1 to the engine/pipeline/index
  (no longer isolated).
- **The gate:** re-run `anchor_recall_harness` — the scorers now survive the probe, so embed recall can
  finally translate to a chosen anchor; measure embed vs lexical against the ≥80% / no-regression bar.
- **No regression:** full `bun test` (the `*_seams` oracles are pre-resolved fixtures, unaffected; the
  live-resolution tests must stay green — a barrel fixture is the only expected new behavior).

## 5. Risks / bounds

- **Over-broad fan-out:** a widely re-exported symbol (a big barrel) could pull in many transitive
  consumers. Mitigate with the hop cap + the existing consumer caps downstream; `log()` if truncated.
- **`export * from`:** not handled (no named symbol). Out of scope here; the private-app case is all named
  re-exports. Note it as a known gap.
- **Cross-language:** TS/JS only (the re-export syntax is theirs). Python/others unaffected.

## 6. Phasing

- **P1:** parser flag + `scan_consumers` closure + the unit fixture. Cheap, contained, portable test.
- **P2:** live re-check on private-app + re-run the anchor-recall gate; decide embed default-on from the number.
