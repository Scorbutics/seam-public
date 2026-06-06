# Read-Time Change Decomposition — Model & MVP Design

*Working synthesis. Supersedes the "block" method documents.*
*Status: the smallest MVP (§9) has been BUILT and iterated on real diffs across 4 languages — see §12 for the architecture and the empirical findings that came out of it. §1–§11 are the conceptual foundation (still load-bearing); §12 is implementation reality. The headline model change from building: `test` is now a fifth role (§2). The core tool-vs-discipline question (§8.2) remains unanswered by data.*

---

## 0. What this document is

A consolidation of a multi-day investigation into a single felt problem: **code review is breaking under AI-scale change, and there is no good solution today.** The investigation passed through several abandoned framings (a code-quality grader, a static "block" architecture system) before landing on the current one: decomposing a change *at read time* into a small set of roles, each with its own trust mechanism, so a human can review a tangled diff non-linearly.

This is a design and build reference, not a manifesto. It is written to be honest about its own evidence so that building does not paper over the open questions. The discipline throughout: a finding is only as strong as the mechanism behind it, and a mechanism is only real if someone could test it and find it false.

---

## 1. The real problem (this is the load-bearing part)

The pain is not architectural drift, not code quality, not "scoping the AI." The pain is that **review no longer works** — including review of one's own AI-generated code.

The current PR review process has structural defects that AI did not create but made unignorable:

- It is **linear and file-by-file.** You read small fragments that carry no meaning without the whole picture, then go back once you grasp the intent — or you don't go back, and rubber-stamp.
- It is **emotional and mood-dependent.** Trust in a review is a function of the reviewer's fatigue, mood, and social dynamics with the author. The same change reviewed by the same person on two different days gets two different levels of scrutiny.
- It **does not survive scale.** A 100+ file PR exceeds the reviewer's cognitive context. Nobody reviews the unit tests on a large PR; coverage gets faked; people approve with no comment. You can spend an hour and miss the one line that leaks an API key.
- AI **makes changes arrive tangled and unauthored.** More code, faster, none of it held in a human head during creation. The reviewer is handed a blob to comprehend, not a change they sequenced.

The honest framing of the options:

1. **Accept it** — review becomes the job, at huge time cost, with a process not adapted to large changes. Rejected: optimizing how file diffs are *displayed* is not enough; this needs a paradigm shift.
2. **Ignore review** — don't read the code. Possibly correct *eventually* if models become reliable enough to one-shot anything — but at that point coding itself largely disappears into prompting, which is a different world this document does not address.
3. **Untangle at write time** (Beck / static blocks) — prevent the tangle when you control authorship. Good for *new* code. Largely inapplicable to legacy code and to code you didn't author.
4. **Untangle at read time** (this model) — recover the structure of a change you were handed. The only operation available in the two conditions that actually matter: code you didn't author (AI) and code with no clean boundaries (legacy).

The product lives in option 4. **Adding an unstructured LLM on top of review is explicitly rejected** — it adds noise and builds no trust.

---

## 2. The model

A single coherent change decomposes into a small set of **roles**. The roles are not arbitrary: each exists because it demands a *structurally different kind of trust evidence*. This is the generative rule — **a category earns its place only if it corresponds to a distinct way of being trusted.**

| Role | What it is | Trust mechanism |
|---|---|---|
| **Core** | The new or changed logic — the thing the change is fundamentally about | Behavioral: does it work, is it complete (the set of use cases it should cover) |
| **Link** | The joints wiring the new thing into the existing system, including parameters threading across layers | Contract: do the integration points hold, do interfaces match at every layer |
| **Environment** | Ambient ripple — shared utilities, global CSS, cross-cutting concerns touched by the change | Impact: what else does this affect, is it scoped correctly (often *not* fully knowable without running it) |
| **Test** | Code that *verifies* the change — it **covers** the cores it exercises rather than being the change | Verification: execution is delegated to CI (skim the internals), but whether the coverage is *real* (would catch a regression) is delegated to no one |
| **Noise** | Renames, formatting, indentation — no logical effect | Essentially none; confirm it really is noise |

**Vocabulary provenance** (kept honest per the metaphor discipline): *core* and *environment* named after observing a new-thing-vs-ambient-ripple split; *link/joint* named after observing that integration seams are a distinct high-risk surface (a joint bears load where two parts meet); *noise* named after observing a class of change that needs no verification. The mechanical/body metaphor fits *where it was drawn from observation* and is allowed to break elsewhere — where it breaks is information (e.g. "noise" is barely mechanical, which correctly signals it is a different *tier* of thing from core/link).

### Test — the earned fifth role (updated after building)

*This document originally said tests were "not a fifth role." Building proved otherwise — and the reversal is consistent with the model's own generative rule.* Apply the rule honestly: does a test have a **distinct trust mechanism**? Yes — **verification** ("is the coverage real, would it catch a regression?"), which is none of behavioral/contract/impact. Two facts forced the promotion:

1. **It passes the rule.** A test's trust is genuinely its own. Part of it is *delegated* like data/config (execution → CI; you skim the logic, you don't review it as core) — **but the delegation is incomplete**: CI happily passes a faked or vacuous test, so "is the coverage real?" is delegated to *no one*. That undelegatable residue is what makes it a category, not just delegated input.
2. **Forcing it elsewhere broke the structure.** Jamming tests into *link* (an early simplification) made every test *wire* the features it covers → it became a hub that dominated the wiring graph. Category mismatch corrupting the structure is exactly the "where the metaphor breaks is information" signal.

So a test **covers** the cores it exercises (a verification relationship — kept as useful info: an untested core is a review risk) but it does **not** wire them. Posture: lighter than core (skim, don't decompose its internals), but surface the one thing nobody else checks — **which cores are covered vs. ⚠ untested**.

**Hold the line after this.** Test is the *one* extra role that earns its place. Data/config below stays *not* a role.

### Data / config — a special case, *not* a role

Pure data and config changes do **not** decompose usefully. They are *input to an existing, already-trusted algorithm* — trust is **fully delegated to the consumer** (unlike a test, whose coverage-quality is undelegatable). You don't ask "is this value correct," you ask "does a trusted consumer exist, and is this input within the range it was verified to handle." (Nuance learned: a config value that *decides behavior* — a threshold/policy — is a rule, so it's **core**, not passive data.)

Consequence: on a *pure* data/config change the model adds little value, because there is only one role and therefore no triangulation (see §3). This is the model correctly reporting its own boundary, not a flaw. The caution: on legacy code the consumer is often *itself* unvalidated (the global-CSS-fallback case), so the delegation breaks down precisely where it matters most — which usefully names the hard part of data/config trust as *the unverifiable consumer.*

---

## 3. The key mechanism: triangulation (most novel finding)

This is the finding that distinguishes the model from "a nicer way to label diffs." It came directly out of the manual test, as an observed mechanism:

- A **core** read in isolation says "here is a new thing" but not *why* or *where*.
- A **link** read in isolation is almost meaningless alone.
- **Core and link together triangulate the intent** of the whole change. Links tell you *where to expect* cores; cores (via naming/specificity) sometimes reveal intent before you've even seen the links.
- The links are then found "where you expect them to be." **If you find yourself thinking "why is this core linked *here*?" — your review is wrong; you missed the point.**

That last property is the valuable one: the decomposition becomes **self-checking**. A surprise is not just a surprise — it is a signal that your mental model of the change has failed. A linear file-by-file review cannot do this, because it has no expectation to violate.

**Discipline note:** "triangulation" is the working name for this mutual-revealing mechanism and it earns its place because it describes something observed. It is closer to a **grammar** (what is allowed to connect to what; is this connection well-formed) than to a **geometry** (points and distances). Do **not** promote it to a "3D distance model" or any spatial formalism unless that formalism makes a concrete prediction that has been checked on a real diff. As of now it has not. Keep the metaphor as a probe, not a finding.

---

## 4. The unification (why "blocks" kept coming back)

The abandoned static-block model and this decomposition model are **the same ontology in two different modes**:

- **Declared / persistent mode** (static blocks): on clean or new code, the core/link/environment structure can be declared once and frozen into the filesystem — block = core, snaps-to/offers = link, floor = environment. Works because the code was built to hold the structure.
- **Derived / per-change mode** (this model): on legacy or AI-generated code, the same structure was never frozen, so it must be *recovered from each change*.

The static model kept reappearing not out of attachment but because the underlying structure was identical and the words weren't there yet. This resolves it: **the decomposition is the durable artifact; the static-block declaration machinery is one optional way to persist it when the codebase is clean enough.** The decomposition works everywhere; the declarations only work on clean code. Therefore the decomposition is the foundation and blocks are a possible later optimization — the *opposite* of the original ordering, and the correct one.

One thing to verify, not assume: that read-time **link** truly equals declared **snaps-to + offers**. Suspicion (from the parameter-propagation observation) is that read-time link is *richer* — it includes informal couplings that aren't formal dependencies. If so, the models are not perfectly isomorphic, and the difference is exactly where the read-time model earns independent existence.

---

## 5. Prior art (be able to cite this; it makes you credible, not less original)

- **Kent Beck — Structure/Behavior changes ("Tidy First").** The closest ancestor. Beck *classifies* a change as structure or behavior, and his project is to *separate and sequence* them (tidy first, in separate diffs, review one hat at a time). This model does the opposite operation: it *groups* one coherent change into roles that only make sense together, at *read* time, for changes you didn't author. Beck is prescriptive (how to make changes); this is diagnostic (how to trust changes you were handed). His reversibility/optionality framing is worth borrowing: core (behavioral, costly to get wrong) deserves heavier verification than link/environment (structural, more reversible). The strongest Beck-style objection — "untangle at the source" — assumes you author and sequence the change, which is exactly the assumption AI and legacy code break.
- **Commit-untangling research** (SmartCommit and successors). Proves the decomposition operation is automatable (median 71–84% accuracy; categories like "hard/soft/refactoring/cosmetic" — cosmetic ≈ noise). Good news: the partitioning is known-feasible. Caution: pure auto-untangling is a crowded research area. The edge here is the *review lens and trust framing*, not the partitioning algorithm.
- **Conventional Commits.** Classifies whole commits by author *intent* (feat/fix/refactor/style/...). Different axis: intent of a whole commit, not internal structure of a single change by verification need. "Noise" overlaps "style."

**What appears genuinely novel:** the role decomposition organized by *verification need* (core/link/environment/test, + noise); **link as a first-class, high-risk role** (no clean equivalent in the prior art); the **triangulation/self-check mechanism**; and the application of all this at **read time** to unauthored/legacy changes.

---

## 6. What the MVP is — and what it is not

**Is NOT:**
- An LLM that reviews the PR for you (rejected: adds noise, builds no trust).
- A better diff *display* (rejected: optimizing file-by-file rendering is not the paradigm shift).
- The static-block system (abandoned).
- The full roadmap from the old block spec.

**IS:** a tool that takes a real diff and **presents it decomposed by role** (core / link / environment / test / noise — see §2), so a human can review **non-linearly** — reading by role and by intent rather than by file, top to bottom.

The obstacle this removes is concrete and was felt directly in the test: with current tooling, the reviewer must **scroll the whole diff linearly first, just to manually reconstruct the decomposition.** That manual reconstruction is a tax. The MVP's job is to pay that tax for the reviewer so the structured, triangulating review can happen without the linear scroll fighting it.

The human still judges. The tool only stops the linear interface from destroying the structure before the human can see it.

---

## 7. Evidence so far (one test, honest)

Single manual test, same legacy codebase, one feature-ish AI-generated change, two readings (default review, then decomposition review) with a real break between them and predictions written first.

- **Time:** 25 min → 15 min (~40% reduction), *despite* paying the manual-decomposition tax. So 15 min is a floor, not a ceiling.
- **Trust:** 3/10 → 5/10. (Default review trust was low partly via *avoiding* trust — "the author is responsible.")
- **Mechanism observed:** the core↔link triangulation and the "why is this linked here?" self-check (§3). This is the part that is not mood-dependent narration.

**What this settled:** the decomposition *does something* — it reallocates attention, surfaces intent faster, and self-checks comprehension. The "pure decoration / changes nothing" outcome is ruled out. Time and trust moved in the right directions *together*, which is unusual and is the signal.

**What it did NOT settle** (see §8).

---

## 8. Open questions — validate before committing real build time

1. **Robustness across change types.** Only one feature-ish change has been tested. Run the same two-reading protocol on: a pure **bug fix** (one line, no new structure — does it have a core but no link?), a pure **deletion** (trust question inverts: is anything still depending on what was removed? — stresses link hard), and a **config-only** change (tests the data/config delegation). A role that *correctly does not apply* is fine; a role you have to *force* is a problem.
2. **Tool vs. discipline.** Does the *tool* (auto-decomposed presentation) deliver the value, or is most of the value in the *mental discipline* a human applies by hand? The test couldn't answer this because the interface fought the method. This is the single question that justifies building: the structured presentation can only be tested by building it.
3. **The external-person test (highest priority for honesty).** All evidence so far is self-generated, by the person who *already has* the senior reviewer's intuition. Give the four-role frame to a *less senior* developer and have them review with and without it. If it helps them, the value is transferable (a reviewing tool). If it only helps the expert, the value is teaching/vocabulary (a different product). Cannot be resolved by introspection.
4. **The triangulation formalism.** "Grammar of well-formed connections" is the current best description. Any spatial/distance formalism is an *untested probe* and owes a concrete, checked prediction before it is believed (e.g. "links threading more layers carry more risk").
5. **Link vs. snaps-to.** Is read-time link richer than declared dependencies (§4)?

---

## 9. Build guidance for the smallest MVP

The next step is a *small* build whose only purpose is to answer question 2 (tool vs. discipline). It is itself an experiment, not a product launch.

- **Smallest viable thing:** take one real diff and render it grouped by role (core / link / environment / noise), reviewable by category instead of by file. Even crude — a script that buckets hunks and lets you read by bucket — is enough to test whether removing the linear-scroll tax makes the method *dramatically* better or only marginally.
- **Decomposition source:** start with the cheapest mechanism that works (heuristics + the existing untangling literature; an LLM pass *to bucket hunks* is acceptable here because it is structuring, not judging — distinct from the rejected "LLM reviews for you"). Determinism is desirable for the *trust* part but not required to test the *presentation* hypothesis.
- **What the tool must NOT do:** approve, score, or pass judgment on the code. It presents structure. The human trusts.
- **Success criterion:** on real changes, does reviewing-by-role-without-scrolling feel *dramatically* better than the manual decomposition that already beat linear review? If dramatic → the tool is the product. If marginal → the value was the discipline, and the right deliverable is a written method/framework, not software (which suits a build-in-public, writing-led path).
- **Keep it cheap.** The whole point of the journey so far is that each step cost an afternoon. Do not convert "promising" into a multi-week build before question 2 returns positive. Building before that answer is the documented trap.

---

## 10. Standing discipline (carry this into the build)

- **Pre-register every test.** Write the prediction before looking. It is the closest thing to a lie detector available.
- **Mechanism, not feeling.** "It felt safer/more complete" is the danger signal. Keep evidence in the form of statable mechanisms a skeptic could falsify. The model *will* feel satisfying — that is exactly why feeling cannot be the evidence.
- **Distrust clean results.** Real findings are mixed and self-limiting (a 5/10 with caveats). A triumphant result is a flag, not a celebration.
- **Stay cheap to be wrong.** The danger is never believing in the idea; it is believing so hard you stop running cheap tests and start making expensive commitments on faith.
- **Metaphor is a probe, not a fact.** A name that came *from* an observation is load-bearing; a name that now *tells you* something unobserved is a prediction that owes you a test. Keep a receipt for each term ("named after observing ___").
- **Watch your own behavior.** If, a month in, you are writing *about* the idea or polishing vocabulary more than testing or building it, that is the drift into self-deception. The honest posture is to keep trying to *break* the model, not defend it.

### Where the model does not apply (known boundaries)
- Pure data/config changes (one role, no triangulation — §2).
- Small PRs, which the current linear process already handles well (fast back-and-forth, clear intent) — though small bug-fix PRs carry their own trap (a one-line `malloc`→`calloc` still needs careful review; small ≠ safe).

---

## 11. One-line summary

**Code review is breaking because it is linear, emotional, and not built for AI-scale tangled diffs; this model recovers the structure of a change at read time into roles defined by how each must be trusted, so a human can review by intent instead of by file — validated once on real code as faster *and* more trusted, with the tool-vs-discipline question still to be settled by a small, cheap build.**

---

## 12. What was built (implementation reality)

The §9 MVP was built and iterated against 4 real diffs (C / C++ / Kotlin+Ruby / TS+SQL) under a reliability harness. The pipeline is `diff_source → parser → noise_filter (deterministic) → classifier (LLM) → renderer (HTML graph)`. What the build *taught* — each point is a measured finding, not a hope:

### 12.1 The classifier is TWO passes (different jobs, different needs)

The model is the headless `claude` CLI (the Claude Code subscription — no API key). One mega-pass doing everything was wrong; the work splits by what it needs:

- **Pass A — cluster (thinking ON).** Group hunks into intent clusters. Grouping is reasoning-heavy and the LLM does it *holistically* well (cluster F1 ≈ 1.0). Deriving clusters mechanically from the model's wiring was tried and **rejected** (the model's per-hunk `wires` are too noisy to reconstruct the partition).
- **Pass B — seam + role (thinking OFF).** Roles + seams + spans. Local pattern-matching: *more* accurate AND ~16× faster without thinking. They merge by id; pass B doesn't even need pass A's clusters.

**Critical latency finding:** `claude -p` defaults interleaved thinking ON, burning ~15–22K tokens (~160s) for a ~550-token answer. `MAX_THINKING_TOKENS=0` on the role pass → ~10s, equal/better roles. Clustering keeps thinking.

### 12.2 The role boundaries that actually hold (general, no domain leak)

Sharpened from real confusions. The discriminator is **"decides an outcome" (core) vs "connects/routes" (link)**:
- Size/shape don't decide: a one-line guard or helper that encodes a **rule/policy** (when/whether/which) is **core**, however tiny. A guard that *enforces a policy* (excludes/filters) is core; a guard that *routes by type to wire a new thing in* is a link.
- A behavior-deciding **config value** (threshold/policy) is core; passive data is environment.
- An **adapter/repository** is a link unless its query is the *sole home* of a business rule.
- Import-led fused hunks: split via **spans** (imports = environment, the logic keeps its role).
- *Open issue:* `routing→link` is probably still too broad — a guard that *adds behavior while integrating* is a core (see litergss3, where per-drawable integrations are legitimately cores).

### 12.3 Reliability is the real bottleneck — measured and gated

The LLM is non-deterministic (no temperature control in the CLI). On byte-identical input, role assignment swings; the variance concentrates on genuinely **borderline** hunks (boundary cases), not everywhere.

- **`eval/harness.py`** is a regression gate: `generate` (LLM, cached) / `score` (pure). It separates **stability** (run-to-run agreement; no gold needed) from **accuracy** (vs hand-labeled `eval/gold/`, with a permutation-invariant clustering F1). Run it before/after any prompt/model change.
- **Self-consistency voting:** the role pass runs N=5 times and keeps the **medoid** run → consistent output. Genuinely 50/50 hunks stay variable and are surfaced as **"uncertain"** rather than flip-flopping (honest — fits §6).
- **Stability ≠ accuracy:** a case can be stably *wrong*. Both are measured.
- **Optimize for the visualization, not per-hunk labels.** The role frontier is intrinsically blurry; success is "the report reads as an acceptable representation" — measured via *health* (no spurious warnings, no seam explosion, no orphans), not label-match alone.

### 12.3a Seams: a core can span seams; cross-seam threads

Fine seams (the desired granularity) **scatter a thread** — a core's definition and its use land in different seams. The model's link-`wires` connect via shared *links* (core→link→core), not def→use (core→core).

A **shared-identifier co-occurrence** heuristic was tried to recover the def→use threads language-agnostically (distinctive new identifier in ≥2 seams), surfaced as graph edges + inline `↔` badges. **Removed (2026-06):** too noisy (textual co-occurrence can't tell a call from a shared variable/type without tree-sitter), and it was a workaround for living outside the editor — that navigation belongs to the editor's own go-to-definition (the change↔codebase boundary). The graph now draws only the **wiring** (shared-link) and cross-cluster **file** edges.

### 12.4 The renderer

Intent clusters as graph boxes; seams as nodes; clickable edges open two seams side by side. Per-seam flags surfaced as *look-here* signals (never scores): ⚠ isolated core, dangling link, **uncertain core** (voting was split), and **⚠ untested core** (no `test` covers it — the undelegatable coverage signal §1 says nobody checks). Self-contained HTML (cytoscape + diff2html).

### 12.5 What stayed honest / still open

- **Tool vs. discipline (§8.2)** is still unanswered — we built the tool but haven't run the external-person protocol on it.
- **Routing→link too broad** (§12.2).
- **Clean function-only cross-seam edges** would need per-language parsing — deferred.
- The build discipline (§10) held: cheap, reversible, measured-before-committing; several plausible ideas (deterministic clustering, the seam-merge hack, model-expressed multi-seam) were built and *rejected by measurement*.

### 12.6 Hybrid by default: deterministic roles + wiring, LLM clusters (2026-06)

The original §12.1 framing held grouping AND roling to be LLM judgment. Building a full **deterministic** classifier (`src/classifier_det.py`, zero LLM) as an A/B alternative falsified half of that:

- **Roles are NOT inherently LLM judgment.** A change-magnitude proxy (decision-logic density) + symbol def↔use *direction* (defines-a-used-symbol = core; references-one = link), plus structural tells (`test` paths, import/type/`.sql` = environment, `implements` = adapter→link), beat the unstable LLM on roles (~0.77 vs ~0.55 on the gold cases) — and it's instant, free, and reproducible. Core over-assignment (the LLM's main failure) is controlled by validated-safe rules, not a model.
- **Wiring is a grounding problem with a far higher ceiling than first measured.** The LLM/`candidate_wirings` floor only wired on *newly-defined* symbols; most real edges are a hunk calling a core that **modifies** an existing symbol. Anchoring on a core's full **subject** (defs + modified enclosing symbol + call subjects) lifted wiring F1 from ~0.13 to ~0.63 — above the LLM's ~0.24.
- **Clustering IS the LLM's domain.** Deterministic connected-components grouping (~0.68) loses to the LLM cluster pass (~0.98), and deterministic `intent` is only a symbol name, not product prose.

So the three passes became **independent levers** (`src/engine.py`, one toggle each — `--cluster/--roles/--wiring`, with `--classifier` as an all-three preset), each on one of THREE engines: **det**, **llm**, or **hybrid** (deterministic first, LLM reconciliation on the *residual* only). Passes run in dependency order (roles → wiring → clusters) so a per-pass engine swap never breaks another.

The **default** is `cluster=llm, roles=det, wiring=hybrid`. The **hybrid wiring** is the key one (dogfooded on cal.com's webhooks refactor, where deterministic wiring over-wired big CONTAINER components — a hunk wired to every core that shares a component it merely renders):
- *tier 1* deterministic subject-anchored wiring (recall), minus shared imported chrome (Button/useLocale: external + used in ≥3 hunks → dropped as anchors);
- *tier 2* deterministic reconcile, GATED to over-wired hunks (>4 cores): keep only edges where the hunk mentions a symbol the core OWNS (in its `defines`). A hunk with NO owned edge is a legitimate HUB (a header/barrel declaring many cores) — left untouched, never escalated (the LLM mangles hubs — measured: it pruned litergss3's `FramedView.h` from 6 correct edges, a regression we caught and fixed by excluding hubs from the residual);
- *tier 3* the INVERTED reconcile (Brice's call — symbol-first loses the *meaning* of each technical intent): in ONE LLM call the model (a) NAMES every seam with a technical-intent label (replacing the symbol-derived `readOnly`/`EventWebhooksTab` with `render managed event type alert`), and (b) for each over-wired hunk DRAWS the true dependency line BY MEANING. Then determinism CONFRONTS the draw — keeps the LLM's line and re-adds any owned-symbol edge it missed (recall guard), abstains → keeps deterministic wires. LLM-first/determinism-checks, the opposite of pruning; measured gold-safe across all 5 cases (litergss3's header hub is no longer mangled — the draw+fallback+owned-confront keeps it). NB: an earlier "LLM-first is bad" reading was role-confounded (it used LLM *roles* too) and the standalone Pass-C call was prompt-fragile — given a good draw prompt the LLM wires fine, which is what makes the inversion work.

Result: cal.com over-wiring avg ~4.4→~1.8 seams/hunk, max 17→5, with **zero gold-case regression** (gold hunks never exceed the gate, and hubs are protected). `roles=hybrid` (det + LLM re-judge the low-confidence hunks) and `cluster=hybrid` (det grouping + LLM prose labels) follow the same deterministic-first/LLM-residual shape. `--classifier det` = fully offline; `--classifier llm` = all-LLM.

**Facts as a pluggable IR (the language seam).** Both engines were a tangle of JS/TS-biased regex. Roles/wiring now read a universal **`HunkFacts`** IR (`defines / references / calls / enclosing / decisions / implements / is_test / …`) from a **`FactsProvider`** strategy — the classifier holds zero regex. Producers: `RegexFactsProvider` (generic fragment fallback), `TreeSitterFactsProvider` (full-file AST, optional dep, alignment-guarded, regex fallback per misaligned hunk), and `ExternalFactsProvider` / `MergedFactsProvider` (facts computed outside Python — the VS Code extension's language-server AST, merged per-field over a base). Comments/strings are masked for logic-side facts (an `if` in a comment isn't a decision). Two producers are *correct iff they emit equal `HunkFacts`* — the contract that makes "tree-sitter ≡ VS Code AST" a test (`eval/facts_provider_test.py`, `eval/treesitter_test.py`), not a hope. This is the §10-honest path to the long-deferred "per-language parsing" (12.5): swap the producer, never the classifier.
