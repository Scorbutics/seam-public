# Plan — Intent culmination + domain-key fidelity (codebase auto-grow)

Status: Step 1 + Step 2 + off-collapse relocation all PROTOTYPED + validated (2026-06-16). Scope: the `seam-intent` pass only
(`label_focus_relevance_llm`, `ts/src/codebase/codebase.ts:274`). Grow is **out of scope** — it
stays `auto:det`, FULL resolution, honest blindspots; the dogfood confirmed grow is the durable win.

## 1. Motivation (private-app dogfood, 2026-06-16)

Two auto-grows on `~/dev/private-app` exposed two **coupled** defects, both in the single
`seam-intent` LLM pass:

- **A — "subscribe & gain paid access"** (auto-anchor): spine correct, ★ culmination correct
  (`apply member subscription access`). `members`-table side-writes correctly stayed *supporting*.
- **B — "weekly missions generated & assigned"** (entrypoint anchor `generate-member-missions`):
  1. **Fragile culmination.** ★ landed on **"assign missions via synthetic referees"** — the admin
     *fake-data* endpoint — because it was the only ENDPOINT node touching the anchor table
     (`weekly_tasks`). The real culmination (a `weekly_tasks` **write** in scoring-cycle) was in the
     spine but unflagged.
  2. **Domain rule buried the mechanism.** The actual generation algorithm
     (`pair_weights` / `pair_weight_events` scoring) was demoted to *supporting* by the
     "keep the spine to ONE domain" rule, because its table ≠ the anchor's table.

**Verdict:** spine *membership* is trustworthy; the single climax *pointer* and the *narrow domain
prior* are not. See memory `intent-b-culmination-and-domain-rule.md`.

## 2. Constraints (non-negotiable)

- **CLAUDE.md structure-vs-semantic line.** Fix the **priors** we feed; the LLM keeps the judgement.
  NO keyword-matching test/admin surfaces ("synthetic/fake/test"), NO deterministic culmination
  post-pass. (We already burned on a deterministic domain post-pass — see `subject-continuity.md`.)
- **Ceiling-safe.** Stays ONE `run_pass` call (the 2-min generation ceiling, `two-minute-generation-ceiling.md`).
- **The pass is FRAGILE.** Any prompt/schema change perturbs tier+spine run-to-run
  (`deterministic-grow-and-primed-tiering.md`, `intent-vocab-cluster-only.md`) → harness-gate every step,
  measure **stability** not just one run.
- **Registry-sourced structure.** Subject kinds come from `DOMAIN_SUBJECT_KINDS`
  (`coupling/adapters/index.ts:28`), never a hardcoded table list.

## 3. Structural signals already available (the discriminator)

The fact that separates A (correct) from B (wrong) is **already computed** — we just don't feed it:

| Signal | Source | Use |
|---|---|---|
| **db-write vs db-read** edge | `DB_TABLE_META {produceEdge:"db-write", consumeEdge:"db-read"}` (`coupling/adapters/db_table.ts:11`) | A real culmination of a generation flow is a **WRITE** to the subject table — not an endpoint that merely reads it. |
| **grow direction** `lead` | `_lead_slice` (`codebase.ts:638`), forward/backward | B's synthetic-referee node is a *backward consumer* (an admin caller), not a downstream **sink**. |
| **in-degree** `indeg` | already built in the pass (`codebase.ts:293`) | ENDPOINT = in-degree 0; today this is the ONLY culmination signal — too weak alone. |
| **BFS hop-distance** `dist` | already built (`codebase.ts:295-297`) | terminal depth — a culmination is far from the anchor. |
| **tables per seam** `tablesFor` | `subjectNodes` (`codebase.ts:298-305`) | the domain prior; today it reads ALL tables a seam touches, symmetric to the anchor table. |

**The A↔B discriminator:** *is the sibling table on the traced anchor→culmination spine path?*
In A, `members` is a side-write **off** the path → side-effect. In B, `pair_weights → weekly_tasks`
**is** the path → mechanism. Structural, defensible, no semantics.

## 4. Implementation plan (cheap → risky, each harness-gated)

### Step 1 — Re-ground culmination as a ranked, write/screen-anchored set
Fixes most of B, and produces the schema the LLM-context projection (separate task) needs.

1. **Schema:** replace the boolean `answers` with `culmination` confidence per seam, e.g.
   `{"id":…, "label":…, "tier":…, "culmination": 0..1}` (or a ranked top-k the model emits). Engine
   keeps a **ranked list**; display still picks top-1 (`s.selected`), but the ranking is retained in
   `seams.json` for downstream consumers.
2. **Prior:** in `hintFor` (`codebase.ts:306`), tag each seam that **writes the subject table**
   (`db-write` edge into a `DOMAIN_SUBJECT_KINDS` node) or **surfaces it on a screen** (terminal,
   in-degree 0, non-boundary) as a *culmination candidate*, plus its grow **direction** (downstream
   sink vs backward caller). The prompt then says: *"the culmination is the candidate where the flow's
   output is produced — a write to the subject, a dispatched job, or the screen it surfaces on."*
3. **Ordering caveat:** `lead` is computed at `codebase.ts:608`, **after** the intent pass (606).
   Move the `_lead_slice` computation before the pass (or recompute the directional signal inside it)
   so direction can feed the prior. `shape` (589) is already available.
4. **Fallback:** the existing "no answer → far end of spine" fallback (`codebase.ts:370-374`,
   `_spine_order` already directed by `lead`) stays as the floor when the model abstains.

**Gate:** A keeps `apply subscription access` top-1; B ranks the `weekly_tasks` write above
synthetic-referees. No tier instability vs baseline across ≥2 runs.

### Step 2 — Widen the domain prior from {anchor table} to {tables on the traced spine path}
Riskier (it's the prior the one-domain rule deliberately narrowed) → behind a flag until proven.

1. Compute the **spine-path table set**: the `DOMAIN_SUBJECT_KINDS` tables touched by nodes on the
   BFS trace anchor→culmination (reuse `_spine_order`), capped (≤2–3).
2. Feed that set as the domain prior instead of `{anchor table}`. Reword lines 330–332: *"the flow's
   domain is {tables on the path}; a seam touching a table OUTSIDE this set is a side-effect →
   supporting."* Model still judges.
3. **The tension is the test:** A *needs* narrow (`members` must stay supporting), B *needs* wide
   (`pair_weights` must join the spine). The cap + on-path membership is what holds A. If A regresses,
   keep Step 2 flagged off and ship Step 1 alone.

**Gate:** B promotes the scoring algorithm to spine; A's `members` side-writes stay supporting.

## 5. Validation

- Add **A and B as regression fixtures** (intent + expected top-1 culmination + spine membership)
  before any change. A = don't-regress guard, B = the target.
- Run `eval/harness` before/after; record tier/spine **stability** across runs (the fragile-pass rule).
- Regenerate the `ts/test/oracle/*.json` codebase oracles (tier/spine/culmination are conditional —
  the schema change touches them).

## 6. Explicitly NOT building

- Keyword detection of test/admin/fake surfaces (semantic trap).
- A deterministic culmination picker / domain post-pass (kept as prior + LLM judgement; prior burn).
- A second LLM pass or more votes (busts the 2-min ceiling).

## 6b. Prototype results (2026-06-16)

Step 1 + the projection are built and validated on the private-app intent-B re-run.

**Engine (`label_focus_relevance_llm`):** added registry-sourced `KEY_PRODUCE_EDGE_KINDS`; the prompt now
tags each seam `WRITES <subject>` / `downstream` / `upstream entry`; `answers:boolean` → `culmination:0..1`
(boolean still accepted); the ranking is retained as `clusters[0].culminationRanked` + per-seam
`culmination`/`writes`/`dir` — all **conditional**, so the non-intent `*_seams` oracles stay byte-identical
(208 pass / 0 fail, typecheck clean).

**Result on intent B** (was: ★ on the synthetic-referee fake-data endpoint):
- `x55` synthetic-referees → **tier `off`, culmination 0** (correctly demoted — it `WRITES subscriptions,
  member_referrals, members`, NOT the subject `weekly_tasks`).
- Top culminations: `persist weekly tasks records` 1.0 (selected) → anchor 0.9 → `save weekly task record`
  0.8 → `compute and persist pair weights` 0.6. The real generative writes win; the scoring algorithm
  (`pair_weights`) rose onto the spine **without** Step 2 (the model judged it spine given the facts).

**Projection** (`--from-seams <f> --format llm-context`, `src/codebase/llm_context.ts`): pure, no-LLM
serializer — header, ordered spine, ranked culmination with confidence + `← selected`, supporting, off-path,
blindspots with SUGGESTED candidates, a "how to use" note.

**Honest limitations found (feed the next iteration):**
1. **Direction was non-discriminating** — the whole grow was one direction (`lead: backward`), so every seam
   got `downstream`. `WRITES` carried the signal; direction only helps on a bidirectional footprint.
2. **Produce-edge coverage gap** — the generative `save` into `weekly_tasks` was tagged `tables:
   weekly_tasks` but NOT `WRITES weekly_tasks` (only the DELETE was). The `WRITES` prior demotes wrong
   endpoints reliably but doesn't always positively tag the true write — a data-coupling resolution gap.
3. **Off-collapse is in the wrong layer for the LLM axis.** `collapse_off_seams` runs in `decompose()`
   BEFORE `emit_seams`, so the emitted model already carries a "+N more dimmed" synthetic seam — the
   projection cannot un-collapse it. To honour "no lossy collapsing for an LLM consumer," collapse must move
   OUT of the engine into the HUMAN renderers (a client concern per `multi-client-not-server-oriented`). It's
   a no-op on the oracles (non-intent → 0 off seams), but it changes the model the extension consumes →
   scope it deliberately.

## 6c. Off-collapse relocation + Step 2 (2026-06-16 — both DONE)

**Off-collapse relocated (gap #3).** `collapse_off_seams` is no longer applied in `decompose()`; the engine
emits the model UNCOLLAPSED and the function is now an `export`ed CLIENT helper (the VS Code extension
already groups seams under a collapsible `off` tier node — extension.ts:1764 — so it needs no change and
arguably improves: individual off-seam labels are now visible). Validated on a fresh private-app intent-B emit:
NEW engine → 76 seams, **no `off-more`/"dimmed concerns" seam**, 29 individual off seams; the projection
shows **0** "+N more" roll-ups. OLD engine → 30 seams with the collapse stub. Oracles byte-identical
(non-intent → 0 off → was already a no-op). The LLM projection now gets full recall.

**Step 2 SHIPPED behind `--promote-spine-path` (default off → oracles/tests unchanged).** A structural,
PROMOTE-ONLY post-pass (`_promote_spine_path`): after tiering, BFS the shortest seam-path between the two
confirmed spine endpoints (anchor seam → culmination seam) over undirected seam adjacency, and promote any
SUPPORTING seam on it to `spine`. Pure topology (path membership), never demotes the model's calls, never
pulls in off-branch noise → **payments-safe by construction** (a `members` side-write hangs off the path →
stays supporting) while it rescues a buried compute table (`pair_weights` on a `weekly_tasks` flow → on-path
→ spine). Unit test (`codebase.test.ts` "Step 2: promote on-path…") proves BOTH directions: on-path
`weekly_tasks` write promoted, off-path `members` side-write untouched. 212 pass / 0 fail, typecheck clean.

## 7. Hand-off to the LLM-context projection (DONE — see §6b)

Step 1's **ranked culmination + retained confidence** is the schema the `--format llm-context`
projection consumes: no lossy collapsing, confidence instead of a boolean ★, token-economical
paths+roles+tables+blindspot-candidates. Same canonical `seams.json`, thin serializer — no forked
semantics (see `multi-client-not-server-oriented.md`).

## 8. Regression & stability coverage (2026-06-16)

**Pinned golds (deterministic, mocked-LLM)** in `ts/test/codebase.test.ts` guard the wins:
- *"pinned gold: Step-1 culmination grounding"* — the synthetic-referee scenario: a flow whose subject
  WRITER (`persistTask` → `weekly_tasks`) competes with an admin ENDPOINT (`submitFakeReferees`) that
  READS the subject but WRITES only foreign tables. Asserts (1) the prior is fed (writer row tags
  `WRITES weekly_tasks`; endpoint tags `WRITES members/subscriptions` but NOT the subject) and (2)
  end-to-end the writer is `selectedSeam` + `culminationRanked[0]`, the endpoint is never spine/answer.
- *"Step 2: promote on-path…"* — on-path compute promoted, off-path `members` side-write stays
  supporting (payments-safe). 214 tests pass.

**Auto-grow STABILITY harness** `ts/eval/autogrow_harness.ts` (gold-free; `generate` N live runs →
`score` run-to-run agreement, keyed on `primary.symbol@file` not seam id). Sonnet vs haiku on
private-app-missions (3 runs each) shows the intent-B climax fragility is **model-tier-dependent**:

| metric | haiku | sonnet |
|---|---|---|
| spine agreement (Jaccard) | 51% | 69% |
| culmination agreement | 67% (modal = the ANCHOR, wrong) | **100% (modal = the `weekly_tasks` write, correct)** |
| tier agreement | 74% | 90% |

→ the Step-1 grounding produces a stable, correct climax on sonnet; haiku wobbles. **The `seam-intent`
pass wants sonnet, not the pinned `claude-haiku-4-5`.** Baselines: `ts/eval/autogrow-baseline{,-sonnet}.json`.
