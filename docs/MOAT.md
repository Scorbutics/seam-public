# The moat — review-impact (the diff↔codebase bridge)

Strategic notes on what makes Seam's diff-mode **review-impact** defensible, what currently stops it
from being a durable moat, and the concrete work to close the gap. Written 2026-06-21 after analysing
the implementation end-to-end and dogfooding it on real fixtures.

The relevant code: [`ts/src/cli/review_impact.ts`](../ts/src/cli/review_impact.ts) (the bridge),
[`ts/src/cli/review_relevance.ts`](../ts/src/cli/review_relevance.ts) (the relevance floor), wired into
`decompose.ts` (`--review-impact` / `--triage`), exposed via MCP `decompose_diff` and the VS Code diff
review (two-step background reveal, `seam.reviewImpact`).

---

## 1. The thesis — what the moat *is*

After a diff is classified, annotate each seam with what the change touches **beyond its own lines**:

- **`external`** — transitive consumers (via `projectImpact`, depth 2) in files **not in the PR**.
- **`crossStack`** — data-flow readers/writers across a shared **DB-table / HTTP-route** key, in files
  **not in the PR**: the *"you changed the write, not the read"* signal.
- **`gaps`** — opaque callers where the view is incomplete (honesty, not silence).

The `!changedFiles.has(...)` filter is the whole point: the signal is *what is affected AND untouched*.
Three layers keep it trustworthy enough to leave ON:

1. **Deterministic relevance floor** (`review_relevance.ts`): `relevant` = the change wrote a field the
   consumer reads; `irrelevant` = both sides pinned **and disjoint** (suppress *only on proof*);
   `unknown` = can't pin either side (never suppressed — recall-safe).
2. **Tiered surface**: relevant shown loud, unknown collapsed to "verify", irrelevant dropped from the
   human view but kept in JSON.
3. **LLM triage** over the `unknown` residual only (never the easy 80%); conservative (`unsure` stays
   unknown).

This is the one place diff-mode and codebase-mode are deliberately bridged. No diff-only tool
(CodeRabbit, Graphite, GitHub) and no codebase-RAG tool (Augment, Cursor) produces it: one has no
codebase graph, the other has no diff anchor and no deterministic write↔read binding.

**Proof it's real** (fixture `ts/test/fixtures/crossstack-repo/charge.patch`, change writes
`payments.fee`): import-based blast radius found **0** consumers; the cross-stack data-flow found **all
three** `payments` readers — `Receipt` reads `.fee` → *relevant*, `Billing` reads whole-object →
*unknown*, `Audit` doesn't read `.fee` → *irrelevant, suppressed*. The differentiator and the
fatigue-killer in one test.

---

## 2. What is genuinely defensible today

- **The cross-stack signal is unique** and structural (not a RAG guess). It's the headline no competitor
  ships.
- **Suppress-on-proof is a trust mechanism, not a feature.** The product bar for a review annotation is
  "trustworthy enough to leave ON." Incumbents whose pitch is *"the AI found bugs"* cannot easily adopt
  *"here's only what we couldn't rule out"* — it's a cultural/positioning moat, not just code.
- **The `.seam/` learned-adapter flywheel** (LLM-once → deterministic-forever) is the *compounding*
  asset: each org's bespoke framework gets learned once and becomes free/offline/reviewable forever.
  This is the durable moat more than any single algorithm.
- **Determinism + offline + cost.** The floor is free; competitors burn tokens per PR.

**Honest framing of "defensible":** the *architecture* is moat-grade. The cross-stack *algorithm*
(footprint + `!changed` filter) is replicable by a determined competitor in months. So the composition
is a differentiator; the durable moat is the trust discipline + the flywheel + the gaps below being
closed.

---

## 3. The gaps blocking a durable moat (ranked) + the fix for each

### Gap 1 — the relevance floor is regex, not AST — ✅ SHIPPED (2026-06-21)

**Done.** [`ts/src/cli/field_facts.ts`](../ts/src/cli/field_facts.ts) extracts written/read field sets via
tree-sitter over the shared `atoms` vocabulary (member access, assignment, object/hash, call, string),
cross-language (JS/TS/Java/Ruby/C/C++). `review_relevance.ts` gained `scoreRelevanceAst` (AST-first, the
regex floor as graceful fallback when no grammar/parse); `review_impact.ts` calls it with the changed
file + new-side line numbers. Recall-safe: dynamic/computed access, spread, serialize → `wholeObject` →
`unknown`, never a false `irrelevant`. Accessor convention resolved (`getFee()`→`fee`, `setFee(v)`→`fee`)
so a Java getter reader is no longer **false-suppressed** (the regex extracted `getFee`, disjoint from
`fee` → wrongly `irrelevant`). Validated: JS verdicts preserved (charge.patch Receipt/Billing/Audit) +
cross-language test `test/diff/field_facts.test.ts` (Java getter/setter, C++ `->`). Remaining within this
gap: getter/setter is a JavaBean convention (fine for Java/JS; revisit for other idioms).

Original note:

`writtenFields` / `readFields` in `review_relevance.ts` are JS/TS-shaped regexes (`_ASSIGN`,
`_WRITE_OBJ`, `_SELECT`, `_MEMBER_READ`). On Java/Ruby/C/C++ they extract little → everything degrades
to `unknown` → more noise, fewer proven-irrelevant. **The hero case (JS frontend → Java backend) has a
strong JS read side but a weak Java write side**, exactly where the moat should be strongest.

This is allowed by the CLAUDE.md discipline only because field-overlap is *structural* (a closed
comparison of identifiers), not semantic — but the **extraction** must be AST, not regex.

**Fix:** route the floor through the existing `FactsProvider` / tree-sitter layer (see
[`facts-provider-strategy`] and `ts/src/diff/facts_treesitter.ts`) instead of raw regex. The
written/read field sets become language-agnostic AST queries (assignment targets, object-literal keys,
member-access reads, ORM column args). Gate on the gold corpus + a multi-language relevance test.

### Gap 2 — field overlap is unbound to the object — ✅ SHIPPED (2026-06-22)

**Done (for the bindable case).** `readFieldsOf(repo, file, key?)` now binds read-fields to the object
carrying the key's data: a `select(cols)` whose chain reads `.from(<key>)` is authoritative, so an
unrelated `widget.fee` elsewhere in the reader no longer counts (was a false `relevant`). `key` (the
shared table/route) threads `review_impact → scoreRelevanceAst → readFieldsOf`. Also fixed a latent leak
(the old `select` extraction collected the whole call subtree, pulling the `.from("payments")` table name
in as a column). Falls back to the whole-file scan when there's no bindable select (the DTO/getter case —
still unbound; full intra-file aliasing of `const x = await …; x.fee` is the remaining tail, deferred).
Validated: `test/diff/field_facts.test.ts` (Mixed.tsx — bound `amount`, unrelated `fee` excluded → change
to `payments.fee` is `irrelevant`); JS verdicts preserved. Recall-safe (binding only ever NARROWS the read
set, and only when a `.from(key).select()` is present).

Original note:

`readFields` collects **every** `x.foo` in the consumer file, not the reads of the *changed symbol's
object*. A name collision (the change writes `name`, the consumer reads an unrelated `.name`) yields a
false `relevant`. False positives erode the very trust the floor exists to create.

**Fix:** bind reads to the object that actually flows from the changed write — resolve the consumer's
reference back to the table/symbol it reads, and only count fields read *off that object*. This is a
small data-flow/binding step (the resolver already knows the table/route key); it converts the floor
from "field names that happen to coincide" to "fields read off the thing that changed."

### Gap 3 — the learned-adapter flywheel — ◐ SURFACED (2026-06-22)

**Surfacing shipped** (the consumption + review halves already existed). The flywheel was *invisible*: a
`det` run replays `.seam/` adapters offline and `seam-adapters` can promote them, but nothing told the
user it happened. Now a run reports it: `coupling/ledger.ts` records which learned adapters were CONSULTED
(replayed) + NEWLY learned this run; `decompose.ts stamp()` attaches `model.adapters` to every emit; the
codebase render (`llm_context.ts`) and the diff review-impact render surface it with a `seam-adapters
promote` hint; the VS Code extension shows a top-level **"Learned adapters (.seam)"** node (✦ new vs
replayed). Pure observability, no-op when nothing learned. Tests: `test/coupling/ledger.test.ts`; 433 pass.
Remaining (the original recall gap below): the user-facing review path still runs floor-only
(`dataCouplingLlm` off) so it doesn't *grow* coverage by default — turning the flywheel in reviews is the
deferred half (a cost/default decision).

Original note:

`crossStack` only fires for the registered deterministic adapters (Supabase, ActiveRecord, jOOQ, raw
SQL, http-route, annotation-route, file-channel). Bespoke ORMs / homemade frameworks are missed unless
learned.

**Fix:** lean into the `.seam/` learned-adapter flywheel — this gap *is* the reason the flywheel is the
moat. Make learning cheap and automatic on first encounter (LLM-once), persist per-repo, and surface
the learned adapter as a reviewable record. The more it's deployed, the more frameworks it covers
deterministically. (This is the compounding-asset loop; prioritise the learning UX, not more
hand-written adapters.)

### Gap 4 — the symbol budget truncates big PRs — ✅ SHIPPED (2026-06-22)

**Done.** Budget raised 60 → 120 (the shared `EngineCtx` makes per-symbol ~0.2s, so this clears virtually
every real PR), and the subject ordering is now core-first **then by change size** (added-line count) — so
when a genuine mega-diff truncates, the largest/most-impactful changes are analysed first and only the
smallest edits drop. The honest `truncated` flag is unchanged ("impact ≥ shown"). Verdicts preserved.

Original note:

The annotation is sequential and capped (`maxSymbols = 60`), so a mega-diff truncates — exactly where
impact matters most. It's flagged honestly (`truncated`), but it's a ceiling.

**Fix:** the per-symbol cost is already ~0.2s after the shared-`EngineCtx` warm-up, so the budget can
rise substantially; beyond that, prioritise by role (core-first, already done) and by changed-field
density, and consider the worker-isolation path only if profiling shows the symbol loop (not the LLM
passes) dominates. Keep the honest `truncated` signal regardless — never silently cap.

---

## 4. Prioritised roadmap — STATUS (2026-06-22)

1. **AST relevance floor** (Gap 1) — ✅ SHIPPED. Cross-language floor; fixed Java-getter false-suppression.
2. **Sound field binding** (Gap 2) — ✅ SHIPPED. Key-bound reads; killed the false-`relevant` class.
3. **Learned-adapter flywheel** (Gap 3) — ✅ SHIPPED (surfacing + default-on learning, **scoped**).
   `dataCouplingLlm` defaults ON in the **review-impact path** (the moat's cross-stack signal — incl. the
   extension diff review); `det`, the anchor probe, AND the **codebase grow/footprint** stay floor-only by
   default. The grow path was deliberately KEPT explicit-opt-in (`--data-coupling llm`): the autogrow
   stability harness showed default-on there breaks **deterministic grow on a cold `.seam/`** (the LLM
   deduces different keys per run → different footprints → the ranked region destabilises; grow 100%→<100%,
   tier 0.99→0.83). It self-heals once `.seam/` is warmed, but we gate cold determinism, so the grow opts
   in explicitly. Review-impact learning is safe by contrast (additive "verify" leads, not a gated region,
   and it warms the cache). `--data-coupling floor|off` opts out; the pass degrades to floor with no backend
   (offline suite unaffected — it no-ops). Validated: floor-blind homemade-ORM learns→persists→replays
   offline + surfaced in `model.adapters`; MCP keeps an explicit floor/llm contract (independent of the
   default). The flywheel turns by default where it's safe (reviews); the grow stays deterministic.
4. **Budget headroom + prioritisation** (Gap 4) — ✅ SHIPPED. 60→120, core-first then change-size ordering.

Net: **all four gaps are now shipped** — the precision/correctness floor (1, 2, 4) is hardened, and the
learned-adapter flywheel is both visible (surfacing) AND turning by default in LLM modes (3). Each piece
was validated against the suite + the cross-stack/floor-blind fixtures before landing (§5). The moat is no
longer "architecture for a moat" — the compounding asset accrues on every hybrid run, deterministically
replayed forever after. Remaining tail (minor): Gap-2 DTO/getter alias tracking; broadening learning
beyond the `cli` backend (copilot can't serve the in-subprocess key pass today).

---

## 5. Discipline that must hold (or the moat inverts)

- **Suppress only on proof.** The moment the floor suppresses something it can't prove unrelated, the
  product becomes "another AI reviewer that misses things" and the trust moat inverts. `unknown` must
  never collapse into `irrelevant`.
- **Information, not assertion.** Cross-stack is framed "reads `payments` — verify", never "this is a
  bug". The judgement stays the reviewer's.
- **Honest gaps.** Opaque callers, truncation, and provenance (`RESOLVED_PARTIAL`/`SUGGESTED`) are
  always surfaced. Silent incompleteness reads as "covered everything" when it isn't.
- **Structural vs semantic (CLAUDE.md).** Field-overlap is structural → deterministic floor. "Does this
  change *matter* to this consumer" when fields can't be pinned is semantic → the LLM triage tier. Never
  approximate meaning with a regex; never delegate a closed structural comparison to the model.

---

## 6. One-line verdict

A strong, differentiated **wedge** today that wins demos and is genuinely useful. It becomes a durable
**moat** when the floor moves to AST (Gap 1), the overlap becomes sound (Gap 2), and the learned-adapter
flywheel is leaned into as the compounding asset (Gap 3). The trust discipline (§5) is the part a
competitor cannot quickly clone — protect it.

[`facts-provider-strategy`]: ../ts/src/diff/facts.ts
