# Plan — #2 anchor recall via embeddings over the def table (Slice B)

Status: PROPOSED (2026-06-16). Closes the "Seam needs an anchor / fuzzy 'where's X' is brittle" gap
vs Augment, WITHOUT conceding #1 (no whole-repo live index). Scope: the auto-anchor RECALL front-end
only — the lexical floor, probe, and judge are unchanged.

## 1. Goal / non-goal

- **Goal:** when the right anchor's NAME doesn't lexically match the intent (e.g. intent "how are weekly
  missions generated" → the real writer is `save` in `scoring-cycle/repositories.ts`), still recall it.
- **Non-goal:** a persistent, real-time, whole-repo semantic index (that's Augment's #1 — conceded).
  This stays **scoped to the def table, embedded on demand, lazily cached** — not a daemon.

## 2. Why lexical can't do it (the finding that forced this)

`find_anchor_candidates` (`anchor_rank.ts`) is **Python-parity-locked by a byte-identical oracle**
(`anchor_rank.json`) and its **name-filter is the bottleneck**: a def is dropped unless its NAME
stem-matches a keyword, so a path-relevant `save@…/scoring-cycle/repositories.ts` is discarded no matter
how well the path matches. Broadening the floor breaks parity; enriching `expand` keywords can't get past
the name-filter; an LLM-only recall is blind without an index. Embeddings are the only lever that raises
recall. (See memory `augment-comparison-and-roadmap`.)

## 3. Where it plugs in (additive, rule-respecting)

```
def enumeration (deterministic)  →  EMBED recall (SUGGEST, new)  ┐
lexical recall (parity floor, unchanged) ───────────────────────┴→ union → probe (deterministic) → judge (LLM SELECT)
```

The embedding layer is an **additive SUGGEST recall** (semantic similarity), grounded by the deterministic
def scan (every embedded item is a real def) — it does NOT touch the parity-locked lexical floor, and the
final pick stays the LLM judge. Same separation the rest of the pipeline obeys: structure enumerates,
LLM suggests/selects, deterministic parts stay 100%.

## 4. The def table (what to embed)

Reuse/extend the `_DECL_RE` scan already in `anchor_rank.ts` to enumerate **all top-level defs** (not just
keyword-matching ones): `{ name, kind, file, signature }` where signature = the declaration line + a
leading doc-comment if present. Embed a compact string per def: `"<kind> <name> — <path> — <signature>"`.
Path is part of the embedding (so `scoring-cycle/repositories.ts/save` reads as mission-domain).

## 5. DECISIONS NEEDED (the point of this plan)

**(a) Embedder — local vs API.** Recommend **local** (offline, no paid API — matches the
`prefer-claude-cli-over-api` ethos and the bundled-.vsix distribution; note: the Claude subscription has no
embeddings endpoint, so "borrow via host" isn't available for embeddings). Candidate: **transformers.js
(Xenova)** running a small model.

**(b) Model.** `all-MiniLM-L6-v2` (~23 MB quantized, 384-dim, fast, proven for code/NL) or
`bge-small-en-v1.5` (slightly better, ~33 MB). Recommend **all-MiniLM-L6-v2** to start (size + speed).

**(c) Runtime backend.** transformers.js can use **WASM** (portable, no native binary — safest for the
Electron-as-Node .vsix) or **onnxruntime-node** (native, faster, per-platform binaries → bundle
complexity). Recommend **WASM first** (portability over speed; recall runs once per query, latency
tolerable), revisit native if cold-start hurts.

## 6. The index — lazy, disk-cached, on-demand (NOT a daemon)

- Embed a def on first encounter; cache the vector on disk keyed by **content hash** of the def string,
  under a gitignored `.seam/embed/` (or OS cache dir). Reuse on subsequent queries; re-embed only changed
  defs. This is incremental + scoped — it amortizes cost without being a live whole-repo index.
- Query: embed the intent once, cosine top-K (e.g. K=20) over the def vectors → candidate pool.

## 7. Retrieval → candidate pool

Top-K embed candidates **union** the lexical candidates, tagged provenance `SUGGESTED` (embed-recalled),
then flow into the existing `select_anchor` probe (shallow grow, drop isolated) + LLM judge. The judge
already picks among connected footprints — now over a higher-recall pool.

## 8. Measurement (the gate is ready)

The per-step accuracy gate already scores **anchor accuracy**. Add 2–3 **fuzzy / lexically-mismatched**
cases to `autogrow-cases.json` with `expectedAnchor` (e.g. an intent whose right anchor's name shares no
stem with the wording), and A/B `--anchor-recall embed` vs `lexical`:
- target: embed recall lifts anchor accuracy to **≥80% (ideal ≥90%)** on the fuzzy cases without
  regressing the clean cases.

## 9. Phasing (cheap → committed)

- **P0 spike — DONE (2026-06-16), PASSED.** transformers.js + `Xenova/all-MiniLM-L6-v2` (WASM), cosine
  over realistic private-app def strings vs the fuzzy intent "how are weekly missions generated and assigned":
  the lexically-mismatched target `save (in class SupabaseWeeklyTaskRepository, scoring-cycle/…)` ranked
  **#3 (0.424), above every distractor** (stripe `applyMemberSubscription` 0.264; junk login/format/JSX
  ≤0.05) — `save` is invisible to the name-filter, so this is pure recall lift. KEY: the def string MUST
  carry the **enclosing class + signature + path**, not the bare name — that moved `save` from #5 (0.215,
  below a distractor) to #3 (0.424). So embed `"<kind> <name>(<sig>) in <enclosing> — <path>"`.
- **P1:** the lazy disk-cached index + def enumeration.
- **P2 — DONE (2026-06-16).** Wired into `select_anchor` behind `--anchor-recall embed` (default
  `lexical`); harness `--anchor-recall` passthrough; `@xenova/transformers` esbuild-externalized in
  `vscode-extension/build.mjs` (bundle stays 370 KB, not +23 MB; absent at runtime → caught → lexical).
  **Validation (recall of the right region, private-app fuzzy intents):** embed recall is an ADDITIVE union, so
  the product pool is `lexical ∪ embed` and recall is monotonic. On 2 scorer-behaviour intents whose
  right anchor (`pairHistoryScorer` in `scorers/`) the name-filter can't reach:
  `lexical 1/2 · embed 1/2 · UNION 2/2`. On intent 1 ("score how well two members match") embed recalls
  `pairHistoryScorer.score` at **#1** where lexical misses entirely. The union never regresses recall and
  strictly improves it on the lexical-miss case. Remaining to graduate to default: a larger fuzzy-case
  set run through the full accuracy gate (`--anchor-recall embed` vs `lexical`, anchor accuracy ≥80%).

## 10. Risks / constraints

- **Bundle size / dependency:** make `@xenova/transformers` an **optional, lazily-imported** dependency,
  loaded only when `--anchor-recall embed` is active. The default build / .vsix carries neither the lib
  nor the ~23 MB model weights (downloaded on first embed-mode use) — so the cost lands only on users who
  opt in, and the parity floor / default behaviour are untouched.
- **Cold start:** first embed loads the model (~1–2 s WASM). One-time per process; fine for a CLI/grow.
- **Dependency:** transformers.js + its WASM runtime is a new dep — vet it builds under bun + the
  Electron-as-Node .vsix path before committing to P1.
- **Escape hatch / default-off:** `--anchor-recall lexical|embed` (default `lexical`) → zero risk to the
  parity floor and the oracles until the gate proves the lift.
