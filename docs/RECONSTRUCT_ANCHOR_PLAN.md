# Plan — Anchor selection by round-trip intent reconstruction (cycle consistency)

Status: PROPOSED (2026-06-16). Replaces/augments the noisy `anchor-judge` (pick-by-shallow-probe-metrics)
with a generate-and-verify selector: shortlist anchors, describe each one's footprint BLIND, compare the
description back to the intent, pick the best match. Scope: `select_anchor` (the auto-anchor path).

## 1. The reframe (why this is the right attack)

An anchor is where **full-semantic intent → one code symbol**. Matching meaning *to a symbol name*
(intent → symbol) is the hard direction — every wobble this thread hit lives there. Cycle consistency
turns it into the easy direction:

```
intent → candidate anchor → footprint → (describe it, BLIND) → intent'  →  compare(intent, intent')
```

`compare(intent, intent')` is **sentence ↔ sentence** similarity — which is *exactly* what an embedding
model is trained for (and where an LLM is reliable), unlike the intent↔code-symbol matching that made
embed-recall phrasing-fragile. The anchor whose footprint, *described*, means what you asked is the right
anchor — regardless of whether its NAME matched.

## 2. The pipeline (reuses the probe footprints — no extra grows)

1. **Recall** — existing `find_anchor_candidates` + `rank_anchors` (∪ embed, optional). Top-K names.
2. **Shortlist (funnel)** — `probe_anchor` each (existing shallow grow), drop isolated, keep the top-N
   (N≈3) by `struct_score`. The probe already produces a footprint per candidate — we reuse it; no new
   grows.
3. **Blind-describe** — one LLM pass: given each shortlisted footprint's facts (ordered symbols, files,
   roles, boundaries/terminals it reaches) but **NOT the intent**, emit a 1–2 sentence "what this code
   does / what flow this is" per candidate → `intent'_n`.
4. **Compare** — `cosine(embed(intent), embed(intent'_n))` per candidate (deterministic). Optional LLM
   "same mechanism? yes/no" only for near-ties.
5. **Select** — argmax match. If the best match < a floor → **"no traceable flow for this intent"** (the
   honesty case: a strategy/computation unit has no spine; say so instead of emitting a 1-seam stub).
6. **Output** — the picked anchor + the ranked list with descriptions (this list IS the fuzzy-ramp view —
   a human confirms by reading what each anchor's footprint *does*, not by guessing from names).

## 3. Two things that make it work

- **Blinding (non-negotiable):** the describe pass must NOT see the intent, or it leaks the question into
  the answer and every candidate "matches." Describe blind → compare separately. This is what makes the
  round-trip a real test, not confirmation bias.
- **Embeddings are in-distribution here.** all-MiniLM struggled at intent→def (OOD); intent↔intent' is
  sentence similarity (its training task) → the compare should be stable and deterministic, the exact
  weakness embed-recall had, removed.

## 4. Implementation

- New `describe_footprint_llm(footprint) → string` (BLIND; a `run_pass` with tag `anchor-describe`,
  routed like the other semantic passes — sonnet). Input = the same deterministic facts
  `judge_anchor_llm` already formats (reach/terminals/crossings/labels), MINUS the intent.
- `select_anchor` gains a strategy: `anchorSelect: "judge" | "reconstruct"` (CLI `--anchor-select`,
  default `judge` until the harness proves it). The `reconstruct` path: shortlist → describe → embed
  (reuse `anchor_embed`'s embedder) → cosine → pick / no-flow.
- No-flow signal surfaces on the emitted model (e.g. `shape: "no-flow"` / a `noFlow` flag) so the
  renderer/agent can say "computation unit, not a flow" instead of a 1-seam spine.

## 5. Validation (the harness exists)

- Extend `anchor_recall_harness` with the `reconstruct` selector; grade against the labeled corpus,
  embed/judge/reconstruct side by side. Bar unchanged: anchor accuracy ≥80%, no regression.
- **Use FLOW intents** (private-app-missions-style) — strategy/no-flow code has no spine, so it's the wrong
  measuring ground for selection; instead include the scorer cases as **negative controls** — the
  selector should return "no flow" (low best-match), not a confident wrong pick.
- Stability: the describe pass is LLM generation (variance) — measure run-to-run agreement; if noisy,
  self-consistency (describe ×3, take the medoid) or a structured "list facts → one-line summary" prompt.

## 6. Risks / bounds

- **Describe variance** — generation is noisier than selection; mitigate with structure + (if needed)
  self-consistency. The COMPARE stays deterministic (embed), so only the description varies.
- **Probe-footprint depth** — the shallow probe may under-describe a long flow. Start with the probe
  footprint (free); if it under-distinguishes, deepen the grow for the top-N only (still ≤3 grows).
- **Cost** — N describe passes + N embeds (cheap) vs the current single judge pass. Bounded by the funnel.

## 7. Phasing

- **P0 spike — RAN (2026-06-16), FAILED the gate.** Intent "how are weekly missions generated and
  assigned"; candidates probed, blind-described (subagents, no intent), embed-compared. The RIGHT anchor
  (`generate-member-missions`) ranked **LAST** (0.176) behind a distractor (`deleteWeeklyMissionsForWeek`
  0.318). The no-flow control worked structurally (`PairHistoryScorer`: 0 terminals, 0 crossings — no
  describe needed). ROOT CAUSE: the embed-compare was fine; the **footprint→description fidelity** is the
  weak link. The shallow BIDIRECTIONAL probe wandered `generate-member-missions` into the
  `pair_weights`-reset/admin region via shared-table data-coupling, so its blind description was "resets
  pair weights by deleting events" — unfaithful → the round-trip can't recover. **VERDICT: don't build P1
  as specified.** The idea needs a FAITHFUL footprint first: describe a DIRECTIONAL/spine footprint (what
  the anchor PRODUCES downstream), or the anchor's own immediate call tree, NOT the wandering bidirectional
  probe with its data-coupling fan. Re-spike with that before P1 — or set aside.
- **P0 re-spike — RAN, the refined recipe WORKS (1 case, promising).** Grow each candidate WITHOUT
  data-coupling (`dataCoupling:false`) → FAITHFUL footprints (the right anchor reads as
  `WeeklyTaskRepository/PairWeightRepository/getCurrentIsoWeek/member repos`, not the reset fan), so the
  blind descriptions are faithful. Embed-compare: the off-domain (password) is now cleanly REJECTED
  (0.295, last) and the right anchor jumps LAST → 2nd (0.404) — but a same-domain distractor
  (`deleteWeeklyMissionsForWeek` 0.465) still edges it on vocabulary (it literally says "weekly mission";
  the right anchor honestly says "weekly TASK") + embeddings missing that DELETE is the opposite ACTION of
  generate. **An LLM RERANK over the top fixes it:** given the 3 blind descriptions (neutral labels), even
  haiku picks the right anchor — it catches delete ≠ generate. **Validated recipe = faithful
  (no-data-coupling) footprint → blind describe → embed narrow → LLM rerank top-2/3**, layering
  structure(det)/embed(fast domain)/LLM(precision) — the hybrid+rerank shape. First POSITIVE
  anchor-selection result of the thread. Caveats: 1 case (needs the corpus); the rerank reintroduces some
  cost/variance but over a TINY set (far less than the noisy anchor-judge over 16). No-flow detection stays
  free (0 terminals/0 crossings). → worth a real P1 build + harness gate.
- **P1:** wire `--anchor-select reconstruct` into `select_anchor` (faithful footprint → describe → embed →
  rerank) + the no-flow signal.
- **P2:** harness gate vs `judge`/`embed`; decide the default.
