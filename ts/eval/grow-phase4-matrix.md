# Phase 4 — side-concern taxonomy flywheel (booking-mini)

The LLM labels each MODULE (module_scope root, top-dir fallback) against the closed side-concern vocabulary
(`concerns.ts`) ONCE, caches to `.seam/concern-map.json` (content-hash keyed), and a warm run applies it with
NO LLM. At the border a candidate in a labelled side-concern module (bearing no crossing) auto-DROPs — I4:
the crossing auto-KEEP is checked first, so a wrong label can never sever a crossing.

## Fixture change (module coherence)

The concern map is MODULE-granular, so a module must be single-concern. The fixture originally put the
low-cosine mechanism `dateRanges.ts` in `util/` next to `logger.ts` — a mixed module a "logging" label would
wrongly drop. `dateRanges.ts` moved to `domain/` (beside its only caller, `availabilityBean`), so modules are
now coherent (`util/` = logging only), mirroring real build-unit modules. The gold region / must-keep updated
accordingly; the file's content (hence its embedding / the Phase 2 low-cosine finding) is unchanged.

## Result

Learned labels (via `claude`, cached to `.seam/`): `util/ → logging`, `notifications/ → notification`, all
other modules → `none` (incl. the `billing/` PEER DOMAIN — a subject, not a concern). Warm reload is LLM-free
(proven in `test/grow/concern_map.test.ts`).

| config | precision | recall | LLM calls | auto-keep / auto-drop / slm |
|---|---|---|---|---|
| slm | 100% | 100% | 5 | — |
| slmres (residual) | 100% | 100% | 4 | 2 / 1 / 7 |
| **slmres + concern** | 100% | 100% | 4 | 2 / **2** / 6 |

The concern map deterministically auto-drops **one more** node (`notifier`) that the field/ubiquity bands
miss — `notifier` sits in the middle intent band (field 0.245) with low ubiquity (1), so neither the field
nor the ubiquity auto-drop fires, but its module `notifications/` is labelled `notification` → auto-DROP. So
the SLM's residual shrinks (slm 7→6) at identical precision/recall. (The wall-clock call count stays 4 here
because the extra auto-decision doesn't empty a whole wave — the same tiny-fixture bound as Phase 3.)

## What shipped / what's deterministic

- **Registry** (`concerns.ts`) is the single source of truth: the border prompt's DROP sentence is now
  DERIVED from it (`concernDropSentence()`), and the hardcoded taxonomy prose in `_prunePrompt` is deleted —
  prompt ⇄ taxonomy can't drift.
- **Flywheel** (`concern_map.ts`): LLM once → `.seam/concern-map.json` → deterministic forever; out-of-vocab
  labels discarded (grounding); stable-floor probe never learns (I5); offline / cold → empty → no effect
  (I1/I3). Flag `SEAM_CONCERN_MAP` / `opts.concernMap`, default OFF.
- **Value**: it removes the ONE must-drop (`notifier`) no deterministic field/ubiquity signal could (a
  low-ubiquity, middle-field side-concern). `billing` stays for the SLM — it is a peer DOMAIN, not a concern,
  correctly labelled `none`.

## Gate note

SLM-backed configs (`slm`/`slmres`/`slmrescm`) are non-deterministic (the model's verdict on the residual
middle wobbles run-to-run), so they are REPORTED, not gated — the deterministic configs are the gated ones.
Cross-repo validation of the flywheel's call-reduction still needs the author's larger repos.
