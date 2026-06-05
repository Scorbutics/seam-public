# Read-Time Change Decomposition — Model & MVP Design

**Version: V2.** *Working synthesis. Supersedes V1 ("block" method documents superseded earlier still).*
*Status: model validated as a comprehension/intent tool through ~2 weeks of real use on legacy and AI-generated code, shipped as a VSCode pre-commit extension (~30s generation on medium diffs). Several load-bearing questions remain open — chiefly Q3 (does it transfer to non-experts), now MORE central because of the V2 intent reframe. Treat everything as validated-to-the-degree-stated, not as settled fact.*

---

## 0. What this document is

A consolidation of a multi-day investigation into a single felt problem: **code review is breaking under AI-scale change, and there is no good solution today.** The investigation passed through several abandoned framings (a code-quality grader, a static "block" architecture system) before landing on the current one: decomposing a change *at read time* into a small set of roles, each with its own trust mechanism, so a human can review a tangled diff non-linearly.

This is a design and build reference, not a manifesto. It is written to be honest about its own evidence so that building does not paper over the open questions. The discipline throughout: a finding is only as strong as the mechanism behind it, and a mechanism is only real if someone could test it and find it false.

---

## 0.5 — V2: what changed since V1, and why

V2 is **mostly a reframe and a sharpening, not a re-ontology.** The core/link/environment role model, triangulation, and the trust-mechanism rationale are *unchanged*. What changed is (a) the **purpose/framing** the tool is understood through, (b) the **unit of analysis** (span, not hunk), and (c) a set of boundary conditions and directions discovered through use. Each item below records *what changed*, *why* (with the receipt), and *scope* (validated / flagged direction / explored-and-dropped).

**The discipline note that governs all of it (read first):** the changes below were driven by *usage and falsification tests*, not by argument or by the appeal of a tidier story. Where a change rests on a single observation it is marked as a flagged direction, not a validated finding. The ontology earned its shape through weeks of trying to break it; the framing earned its correction through real use. Different evidence, different scope of change. Several seductive ideas were *deliberately not promoted* (see J, and the "explicitly NOT changed" note at the end).

### A. Prior art: cite CoRA (the closest ancestor, missing from V1)
- **Change:** Add CoRA (ASE 2019, "Code Review Assistant") to §5. It decomposes a tangled commit into parts *for the reviewer*, generates descriptions, and surfaces the most important part via PageRank, with a human study.
- **Why:** It is the first paper a knowledgeable skeptic names; not citing it was a credibility hole. Borrowable mechanisms: dependency analysis (≈ our **link** signal), tree-based similar-code detection (≈ **noise**/refactor), centrality ranking (a cheap candidate-**core** finder).
- **Caveat that preserves originality:** CoRA partitions by *concern* and ranks by *centrality*. Our axis is *verification need / trust mechanism*. Borrow the mechanism, not the framing, or we collapse back into concern-decomposition. No usable public implementation exists; SmartCommitCore is the runnable substitute for studying the partitioning baseline.
- **Scope:** prior-art correction.

### B. The model's unit is the semantic span, not the diff hunk
- **Change:** Stop treating "one hunk = one role." A **core** can be *part of* a hunk or *span several* hunks. The role is a property of the coherent logic/intent, not of git's accidental chunking.
- **Why (receipt):** §2 always said "the new or changed logic" — never "the hunk." The MVP equated them as an implementation convenience. Observed over multiple sessions, the wrong unit produced two symptoms, in opposite directions: (1) **fusion** — condensed edits flagged *core* because the link was one line, swallowed into the core hunk; (2) **fragmentation** — spread-out edits split into purpose-less "islands," one core scattered across hunks, individually unnameable. This was *frequent — every review*, not merely real.
- **Consequence for any fix:** the problem is *bidirectional*. Fusion wants *splitting*; fragmentation wants *grouping*. A fix that only splits hunks makes fragmentation strictly worse. "Sub-hunk detection" alone is therefore the wrong fix for half the symptom.
- **Status:** validated. Detection has since been tuned/stabilized; fragmentation is largely resolved, leaving residual **over-fusion** (a seam occasionally too big — see E and the over-fusion note).
- **Scope:** corrects an unstated V1 assumption; does not change what a core *is*.

### C. The seam is a first-class object (one core↔link wiring)
- **Change:** Name the **seam** — one core and the link(s) wiring it — as the grain at which triangulation operates. The §3 self-check becomes a *computed* property: a seam is **well-formed** (every core has ≥1 link, every link ≥1 core, within the diff) or **malformed** (isolated-core / dangling-link / ambient-only).
- **Why:** emerged from testing; turns triangulation from narration into something the tool can flag. Deletions correctly surfaced as *dangling-links* (the inverted trust question of §8.1), unforced.
- **Scope:** refinement of §3.

### D. Two tiers — seams are the model, clusters are external grouping by intent
- **Change:** Seams are model objects (generated by "a core demands its link"). **Clusters** are an *external* grouping of seams by intent, for navigation — not model objects.
- **Why (falsification receipt):** a deliberately multi-intent commit (several unrelated PO fixes) produced *5 distinct clusters*, not 1 — so clustering tracks intent and is not inert. Cores name as **"technical sub-intent with standalone purpose"** (e.g. "introduce strategy pattern," "create XXX component") — neither pure *product* intent nor meaningless label. So: **clusters carry product intent; cores carry technical intent.** Two grains of intent, not one recursing externally.
- **Consequence:** the "meta-link between clusters" idea stays *closed* — clusters aren't model objects, so they can't bear model relations. What looked like a wanted meta-link was over-split seam boundaries.
- **Scope:** validated reframe; resolves the long-running cluster question.

### E. The model is scale-free; grain is chosen by a trust-need *stopping rule*, not discovered
- **Change:** core/link recurses at every level (component↔wiring, function↔call, variable↔reference). There is **no intrinsically correct grain** — every level is *correct*, most are *useless*. Grain must be *chosen*, by a stopping rule: **collapse a sub-seam if it is trustable at a glance (needs no triangulation); surface it if confirming it requires checking it against something else.**
- **Why:** the "too-fine" representation (variable+reference seams) is correct but useless; "wrong grouping" is therefore not an accuracy problem but a *wrong-altitude* problem. Accuracy was never the lever — altitude is.
- **Why it's principled (receipt):** this is §2's generative rule applied to *depth*. A *role* earns its place if it needs a distinct kind of trust; a *level of recursion* earns rendering if it needs a distinct kind of *attention*. The rule auto-adjusts per diff (simple diffs collapse to few coarse seams; tangled ones surface more), which is what makes a single sensible default possible without a fragile depth parameter.
- **Status:** **theory, pending hand-validation.** The decisive test: does the *same* trust-need rule produce the wished-for grain across diverse diffs *without per-diff re-tuning*? And: how often is the coarse default right as-is vs. needing a drill (this frequency decides cheap "lazy drill-down" vs. expensive "full recursion" build).
- **Scope:** flagged direction.

### F. Architecture: top-down, context-carrying passes, lazy drill-down
- **Change:** Get the big picture right first, then drill on demand. Each pass feeds its context to the next — but only on the seams the reviewer *expands*.
- **Why:** triangulation is *directional* — the coarse picture explains the fine pieces, not vice versa; bottom-up assembles noise (this is what produced the "purpose-less islands"). Coarse classification is also intrinsically more accurate (more signal per unit), so build the most-accurate, context-supplying layer first.
- **Two risks named:** (1) **error propagation** — a wrong *coarse* call poisons everything beneath it, so the coarse pass must be *reliable*, and a lower pass must be able to signal "this doesn't fit the frame I was given" (which *is* the triangulation self-check operating *between* levels). (2) **latency** — passes are serial; eager recursion is a latency bomb. Hence drilling is lazy: pass 1 always; deeper passes only on expand.
- **Status:** design direction, gated on E's validation and on the coarse pass proving reliable.
- **Scope:** flagged direction.

### G. Test — a 5th element, provisionally a *property* (verification attached to a core), not a peer role
- **Change:** Tests are semantically distinct from core/link and are *not* merely environment (not ambient ripple — they are *verification*). Add "test" as a distinct element.
- **Why (receipt):** tests *recurred on every PR*, polluting the main intents. Promotion was deliberately *held off* on a single instance (the earlier "proof" discussion — one screenshot did not clear the bar) and added only after multi-session recurrence.
- **Open question — role vs property:** empirical literature (Test-Driven Code Review study) leans *property*: tests *context-set* ("what are we building") but developers deem production code primary and tests follow from it. As a property, a test *discharges a core's verification need* — which is more powerful than a peer role, because it resolves lone-core ambiguity rather than just sitting in its own bucket.
- **Scope:** validated-as-distinct; role-vs-property still open, leaning property.

### H. Isolated-core warning: explored, refined, then DROPPED in use
- **Change:** The isolated-core warning is **no longer part of the tool in use.**
- **Why (the most honest piece of usage data here):** it was built and refined over several iterations (softened wording; the diff-boundary-benign vs. true-unverifiable-consumer distinction). It fired on ~50% of reviews, *mostly diff-boundary-benign* (data/config, or consumer in unchanged code), and its true precision was never establishable *because the wrong-unit problem (B) manufactured false isolated-cores.* Then, porting to the VSCode extension, it was **forgotten — because it isn't looked at.** That is revealed preference: the risk feature did not survive real use; the intent decomposition did.
- **Consequence:** prunes the "proof discharges the warning" thread (the warning it would discharge is gone). The base-rate question is moot — the answer wasn't a number, it was "not used."
- **Scope:** explored-and-dropped (kept as honest record). **Key evidence for the risk→intent reframe (J).**

### I. Symmetric boundary — the diff is not the codebase; a seam can be missing *either* end
- **Change:** Document the twin of the isolated core. **Isolated core** = core in the diff, link in unchanged code. **Link-only seam** = link in the diff, core in unchanged code (e.g. *plug/unplug* — rewiring a dependency A→B where both A and B already exist; the change is pure wiring).
- **Why:** both are legitimate, common change shapes; the shared root cause is *the diff is not the codebase*, and the boundary cuts both ways.
- **Sharp consequence:** a link-only seam is the *hardest* to read from the diff alone (a link read alone is nearly meaningless, §3). It is therefore the **strongest motivating case for codebase-awareness** — the case where reaching into unchanged code would pay off most (and, framed right, the highest knowledge-transfer density: "this re-routes A→B; neither changed; here's what that means").
- **Scope:** validated boundary condition. **Codebase-awareness is a flagged direction, NOT a build commitment** (one observation; safe claim is "link-only seams exist and are legitimate," the leap to "therefore build codebase-integration" is unproven).

### J. The reframe: risk → intent (the spine of V2)
- **Change:** The tool is understood, named, and *presented* as an **intent** tool (functional clusters + technical seams), not a risk/defect tool. The default view leads with **intent**, not warnings.
- **Why it drifted (receipt):** the field's gravity supplies *risk*-vocabulary (defect-finding, scoring, gatekeeping), so the tool kept getting *narrated* in risk-words even though the *artifact* stayed intent-oriented. Four pulls observed and resisted: the "feed it to an LLM reviewer" temptation; the isolated-core warning drifting toward "alarm"; "what should I review" nearly becoming "let the tool rank risk"; and an unprompted self-description as "risk-oriented." The build was consistently more trustworthy than the narration.
- **Empirical backing:** review motivations split into a *defect/quality* cluster (find bugs, improve code — the loud, stated, market-optimized half) and a larger *understanding/knowledge/ownership* cluster (knowledge transfer ~38%, team awareness ~38%, shared ownership ~27%; review increases distinct files a dev knows by 66–150%). A controlled study found re-ordering changed files (vs. alphanumeric) raised review quality (+23% comments) — direct third-party support for non-linear, structure-led presentation. The cognitive-model work frames effective review as *recognition-primed* and notes current tools wrongly *center the diff-view*. Our tool attacks exactly that, and serves the *underserved* knowledge half.
- **Consequences for the build:** lead with intent summaries, not warnings; pursue knowledge-oriented features — chiefly **persistence/history** (decompositions kept against the codebase become an *intent-history*, the externalized form of the "mental index" that otherwise takes a year to build). NB: a senior's edge is recognition-primed pattern memory the tool *cannot* supply — the tool accelerates *comprehension and knowledge-mapping*, not *judgment*. That line is the boundary between a comprehension tool and the judge-replacement we always rejected.
- **Scope:** framing/purpose change. **Does NOT touch the ontology.**

### What explicitly did NOT change
The ontology — core / link / environment / (test), triangulation, and the trust-mechanism rationale that generates the categories — is unchanged. V2 changes *purpose* (J), *unit of analysis* (B), *grain selection* (E), *architecture* (F), and records boundaries (C, D, G, H, I). It does **not** redefine what a core or a seam *is*. Resist any "reframe toward intent" that quietly revises the model: the model earned its shape through falsification; the framing earned its correction through usage.

---

## 1. The real problem (this is the load-bearing part)

The pain is not architectural drift, not code quality, not "scoping the AI." The pain is that **review no longer works** — including review of one's own AI-generated code.

The current PR review process has structural defects that AI did not create but made unignorable:

- It is **linear and file-by-file.** You read small fragments that carry no meaning without the whole picture, then go back once you grasp the intent — or you don't go back, and rubber-stamp. *(V2 →) Empirically supported: file re-ordering away from alphanumeric measurably improves review quality.*
- It is **emotional and mood-dependent.** Trust in a review is a function of the reviewer's fatigue, mood, and social dynamics with the author.
- It **does not survive scale.** A 100+ file PR exceeds the reviewer's cognitive context. *(V2 →) There is a hard cognitive ceiling (~400 LOC / ~60 min) that no interface moves — so the V2 framing is "spend the fixed attention budget on the right roles," not "review faster."*
- AI **makes changes arrive tangled and unauthored.** The reviewer is handed a blob to comprehend, not a change they sequenced.

The honest framing of the options:

1. **Accept it** — review becomes the job, at huge time cost. Rejected.
2. **Ignore review** — possibly correct *eventually* if models one-shot anything, but that's a different world. *(V2 →) The regress (write → review → prompt → ticket) bottoms out at **accountability**, not at code: responsibility for outcomes doesn't transfer to a model, so the human migrates to owning outcomes, which is the part this tool serves.*
3. **Untangle at write time** (Beck / static blocks) — good for *new* code, inapplicable to legacy and unauthored code.
4. **Untangle at read time** (this model) — recover the structure of a change you were handed. The only operation available in the two conditions that matter: code you didn't author (AI) and code with no clean boundaries (legacy).

The product lives in option 4. **Adding an unstructured LLM on top of review is explicitly rejected** — it adds noise and builds no trust. *(V2 →) This rejection is load-bearing and recurrent; the "feed our output to an LLM reviewer" idea is the same rejected product in disguise (see J) and is treated as a fork in what the product is, not a feature.*

---

## 2. The model

A single coherent change decomposes into a small set of **roles**. Each exists because it demands a *structurally different kind of trust evidence*. This is the generative rule — **a category earns its place only if it corresponds to a distinct way of being trusted.** *(V2 →) The same rule, applied to **depth**, generates the trust-need stopping rule of E: a recursion level earns rendering iff it needs distinct attention.*

| Role | What it is | Trust mechanism |
|---|---|---|
| **Core** | The new or changed logic — the thing the change is fundamentally about. *(V2: a core is a unit of **logic/intent**, which may be part of a hunk or span several hunks — NOT one-hunk-one-role; see B.)* | Behavioral: does it work, is it complete |
| **Link** | The joints wiring the new thing into the existing system, including parameters threading across layers | Contract: do the integration points hold, do interfaces match |
| **Environment** | Ambient ripple — shared utilities, global CSS, cross-cutting concerns touched by the change | Impact: what else does this affect, is it scoped correctly |
| **Noise** | Renames, formatting, indentation — no logical effect | Essentially none; confirm it really is noise |
| **Test** *(V2, provisional)* | Verification of a core's behavior. *Provisionally a **property** attached to a core, not a peer role (see G).* | Verification: the test *is* (part of) the core's behavioral trust, made executable; its presence can *discharge* a lone core's ambiguity |

**Vocabulary provenance** (metaphor discipline): *core/environment* from a new-thing-vs-ambient-ripple split; *link/joint* from integration seams being a distinct high-risk surface; *noise* from a class needing no verification; *(V2)* *test* named after observing test hunks recur across every PR as semantically distinct from core/link and not reducible to environment. The mechanical metaphor is allowed to break where it wasn't drawn from observation.

### Data / config — a special case, not a role
Pure data/config changes do not decompose usefully — they are *input to an already-trusted consumer*; trust is **delegated to the consumer**, not verified in the change. *(V2 →) This is exactly the benign "isolated core" / diff-boundary case: the consumer lives in unchanged code, so the seam looks isolated though it is well-formed. The hard part is the **unverifiable consumer** on legacy code.*

---

## 3. The key mechanism: triangulation (most novel finding)

- A **core** read in isolation says "here is a new thing" but not *why* or *where*.
- A **link** read in isolation is almost meaningless alone.
- **Core and link together triangulate the intent** of the whole change.
- The links are found "where you expect them." **If you find yourself thinking "why is this core linked *here*?" — your review is wrong; you missed the point.**

The decomposition becomes **self-checking**: a surprise is a signal that your mental model has failed. *(V2 →) This self-check is now a **computed seam property** (C): malformed seams are flagged. And the mechanism is **directional** (F): the coarse picture explains the fine pieces, not vice versa — which is why the architecture is top-down and why bottom-up assembly produced "purpose-less islands."*

**Discipline note:** "triangulation" is closer to a **grammar** (what may connect to what; is this connection well-formed) than a **geometry**. Do not promote it to a spatial formalism without a checked prediction. *(V2 →) The recursion (E) is also a grammar fact, not a geometry: there is no "distance," only well-formed connection at a chosen altitude.*

---

## 4. The unification (why "blocks" kept coming back)

The abandoned static-block model and this decomposition model are **the same ontology in two modes**: declared/persistent (static blocks, on clean code) vs. derived/per-change (this model, on legacy/AI code). **The decomposition is the durable artifact; block-declaration is one optional way to persist it on clean-enough code.**

*(V2 →) The "durable artifact" intuition resurfaces in J as **intent-history/persistence**: keeping per-change decompositions against the codebase accumulates the externalized "mental index" that knowledge transfer and ownership depend on. This is the most promising knowledge-oriented direction, and it is unmistakably an intent artifact, not a risk one.*

To verify, not assume: that read-time **link** equals declared **snaps-to + offers**. Suspicion: read-time link is *richer* (informal couplings, not just formal dependencies) — which is where the read-time model earns independent existence.

---

## 5. Prior art (be able to cite this)

- **Kent Beck — Structure/Behavior ("Tidy First").** Closest ancestor in spirit. Beck *classifies* and *separates/sequences* structure vs. behavior at *write* time. This model does the opposite operation: it *groups* one coherent change into roles that only make sense together, at *read* time, for changes you didn't author. Borrow his reversibility framing: core (behavioral, costly to reverse) deserves heavier verification than link/environment (structural, more reversible).
- *(V2)* **CoRA — Code Review Assistant (ASE 2019).** *The* closest direct ancestor (was missing from V1). Decomposes a tangled commit into parts *for the reviewer*, describes them, and ranks the most important part via PageRank, with a human study. Borrow: dependency analysis (≈link), similar-code detection (≈noise), centrality (≈candidate core). **Distinction that preserves originality:** CoRA partitions by *concern* and ranks by *centrality*; this model partitions by *verification need / trust mechanism*. No public implementation; SmartCommitCore is the runnable substitute.
- **Commit-untangling research** (SmartCommit, Flexeme, UTango, recent LLM-multi-agent entrants). Proves the partitioning is automatable (median 71–84%); categories like hard/soft/refactoring/cosmetic are *edge types for clustering*, not roles by trust need (cosmetic ≈ noise; the rest don't map). The edge here is the *review lens and trust framing*, not the algorithm.
- **Conventional Commits.** Classifies whole commits by author *intent* (feat/fix/...). Different axis from internal structure by verification need.

**What appears genuinely novel:** the role decomposition organized by *verification need*; **link as a first-class, high-risk role**; the **triangulation/self-check mechanism** (now a computed seam property); the application at **read time** to unauthored/legacy changes; *(V2)* the **scale-free recursion with a trust-need stopping rule**; and the deliberate **intent (not risk) framing** that the empirical motivation data supports and the market under-serves.

---

## 6. What the MVP is — and what it is not

**Is NOT:** an LLM that reviews the PR for you (rejected); a better diff *display* alone; the static-block system; the full old roadmap. *(V2 →) Also NOT a risk/score tool, and NOT a feeder for an LLM reviewer — that fork rebuilds the rejected product.*

**IS:** a tool that takes a real diff and **presents it decomposed into intent — functional clusters of technical seams (core / link / environment / [test] / noise)** — so a human can review **non-linearly**, by intent rather than by file. *(V2: the framing is **intent**, led by clusters and seams; warnings are de-emphasized — see H, J.)*

The obstacle removed, felt directly: the reviewer otherwise must **scroll the whole diff linearly first** just to reconstruct the decomposition. The MVP pays that tax. *(V2 →) Concrete validated value: **the elimination of CTRL+F** — the tool mechanizes the manual triangulation motion (find a symbol, hunt its uses, hold them in your head). "I don't CTRL+F anymore" is the sharpest true statement of the value.*

The human still judges. The tool only stops the linear interface from destroying the structure before the human can see it. *(V2 →) The tool accelerates **comprehension/knowledge-mapping**; it does not supply the **recognition-primed pattern memory** that is the senior's real edge. That line is deliberate.*

---

## 7. Evidence so far (V2 — updated)

**V1 evidence (one manual test):** 25→15 min (~40%, with the manual-decomposition tax still paid, so a floor); trust 3/10→5/10; triangulation and the "why is this linked here?" self-check observed. Ruled out "pure decoration."

**V2 evidence (~2 weeks of real use, shipped VSCode extension):**
- **Shipped:** VSCode extension, ~30s generation on medium diffs — fast enough for **pre-commit** use (which is also the structural *gate* the solo-project discipline needs; a review you never open can't be improved by a better interface).
- **Q2 (tool vs. discipline) — effectively answered.** A bucketing-only version was *marginal*; adding **clustering + triangulation** made it *dramatic*. Per the §9 criterion, dramatic-vs-marginal was the decider: **the value is in intent-clustering that places core and link adjacent, not in role-labeling.**
- **Falsification passed:** a deliberately multi-intent commit produced 5 distinct clusters (clustering tracks intent, isn't inert). Deletions surfaced as dangling-links (inverted trust, unforced).
- **Honest texture:** "helpful, not wow." **Useless on small PRs** (the model correctly reporting its own boundary — small PRs the linear process already handles). Strong on **large, tangled, AI-generated diffs**, especially catching where code diverged from the plan that produced it.
- **Wrong-grouping / over-fusion** is the residual issue (see the note below).
- **Method note:** AI made iteration cheap (jump in, revert, keep what survives). This is "stay cheap to be wrong" accelerated — *but* with building cheap, the scarce/valuable step is now **pre-registering the prediction** before each try; without it, fast iteration becomes vibe-testing dressed as rigor.

**What V2 did NOT settle:** Q3 (below). All evidence is still self-generated by someone who already has the senior reviewer's intuition.

---

## 8. Open questions — validate before committing real build time

1. **Robustness across change types.** *(V2: largely exercised — feature, multi-intent bundle, deletion-as-dangling-link, data/config-as-benign-isolated-core all behaved correctly. Bug-fix and pure-deletion protocols still worth a clean run.)*
2. **Tool vs. discipline.** *(V2: effectively answered — clustering+triangulation is the dramatic gain; categorising alone is marginal. See §7.)*
3. **The external-person test (highest priority — and now MORE central).** All evidence is self-generated. *(V2 →) The intent/knowledge reframe (J) makes Q3 the whole ballgame: if the value is knowledge transfer, the question of whether the decomposition teaches **someone who isn't you** is the product. Deliberately deferred until the tool is polished — correct sequencing — but it is the gate to "product for others." Run it with a less-senior dev, with predictions pre-registered; do not let build-in-public applause stand in for it.*
4. **The trust-need stopping rule / altitude (E).** Does one rule give a good default grain across diverse diffs without per-diff re-tuning? How often is the coarse default right vs. needing a drill? *(Decides cheap lazy-drill vs. expensive full-recursion build. Hand-validate before building.)*
5. **Wrong-grouping cause (the live one).** Over-fusion (seam too big): is it **Cause A** (grouper draws boundaries wrong on *separable* structure — fixable, a *boundary* algorithm not a *decoupling* one) or **Cause B** (the code is *genuinely entangled* — no correct boundary exists; the big seam is honest and forcing a split would make the tool lie)? *(V2: read the A/B ratio off real diffs before any build. Some "inconsistency" is the model correctly refusing to invent boundaries.)*
6. **Test: role vs property (G).** Does it keep behaving as verification-attached-to-a-core (property), or as a peer role?
7. **Link vs. snaps-to.** Is read-time link richer than declared dependencies (§4)?
8. *(V2)* **Codebase-awareness.** Would resolving seams against unchanged code (isolated-core and especially link-only seams, I) deliver enough to justify crossing from diff-only to codebase-aware? *Flagged direction only.*

---

## 9. Build guidance for the smallest MVP *(V2 — re-pointed)*

V1 guidance (smallest viable thing; cheapest decomposition source; tool must NOT approve/score; keep it cheap) **still holds.** V2 additions:

- **Top-down, lazy drill-down (F).** Generate the coarse picture always; recurse into a seam *only on expand*. Don't build "represent all sub-levels up front" until the hand-test (Q4) shows the coarse default is *frequently* wrong. If it's usually right and only occasionally needs a drill → lazy expand is the whole fix (cheap).
- **Lead with intent, not warnings (J).** The default surface should assert the tool's intent-purpose loudly enough that the field's risk-gravity can't quietly relabel it. The isolated-core warning has been dropped in use (H); don't reinstate risk-led surfacing.
- **The over-fusion fix is a *boundary* fix, not a *decoupling* fix (Q5).** Decoupling (within a hunk) cannot fix wrong grouping (between seams). If Cause A dominates, the fix is better boundary-drawing (candidate: deterministic dependency-graph grouping rather than LLM judgment). If Cause B dominates, there is little to build — let the big seam stand.
- **Knowledge-oriented direction: persistence / intent-history (J, §4).** Keeping decompositions against the codebase is the highest-leverage knowledge feature and is unmistakably an intent artifact.
- **Success criterion (unchanged):** dramatically-better → the tool is the product; marginal → the deliverable is a written method/framework (the writing-led path), which — given the market ships LLM-reviewers — is a legitimate outcome, not a consolation.
- **The documented trap (sharper in V2):** with building now cheap, the trap is no longer "build before Q2 returns" — it is **keeping a direction because it *felt* right rather than because it passed a pre-registered bar.** Reverts launder keepers. Pre-register, or the cheap loop stops being a test.

---

## 10. Standing discipline (carry this into the build)

- **Pre-register every test.** *(V2: now the scarce, high-value step, because AI made building cheap. One line — "I expect X, I'll know by Y" — before each try.)*
- **Mechanism, not feeling.** "It felt safer/more complete" is the danger signal. *(V2: the model **and** a fresh feeling that contradicts a prior reasoned decision both deserve scrutiny — recency and vividness are not correctness.)*
- **Distrust clean results.** Real findings are mixed (a 5/10 with caveats; "helpful, not wow"). *(V2: three agreeing articles and a legible report are clean signals too — a negative "drop it" reflex is the same mood-driven failure as "it's brilliant.")*
- **Stay cheap to be wrong.** *(V2: AClause — separate the **detection** of a problem (you, by hand, are the perfect-accuracy classifier) from the **fix** (expensive). If a hand-pass with zero accuracy limitation **still** fails, the flaw is the **approach**; if only the tool's version fails, it's **accuracy/implementation**. This hand-pass is the one move that factors out the accuracy-vs-approach confound — the hardest question in the project.)*
- **Metaphor is a probe, not a fact.** Keep a receipt ("named after observing ___"). *(V2: "test," "seam," "wired group," and the trust-need rule each carry their receipts above.)*
- **Watch your own behavior.** If you're writing/polishing the idea more than testing or building it, that's drift. *(V2: the **risk-vocabulary pull** is a standing current, not a one-off — observed four times. The artifact stayed intent-oriented even when the narration drifted; trust the build over the narration, and make the interface assert intent so you don't have to remember to resist.)*

### Where the model does not apply (known boundaries)
- Pure data/config changes (one role, no triangulation; the benign isolated-core / diff-boundary case).
- Small PRs, which the linear process already handles well (and small ≠ safe: a one-line `malloc`→`calloc` still needs care).
- *(V2)* **Global coherence / architecture / design drift.** Per-diff review is *local* by construction and is structurally weak against the accumulation-level drift that worries solo AI-assisted development most. The mitigation is *upstream* (plan-review) and *coarser/periodic* (architectural passes) — not this tool. Don't let per-diff diligence create false confidence about global health.
- *(V2)* **Seams missing an end** (isolated-core; link-only). Honest "go look outside the diff" cases; the boundary is *the diff is not the codebase* (I).

---

## 11. One-line summary *(V2)*

**Code review is breaking because it is linear, emotional, and not built for AI-scale tangled diffs; this model recovers the structure of a change at read time into *intent* — functional clusters of technical seams (core / link / environment / [test] / noise), each defined by how it must be trusted — so a human can review by intent instead of by file. Validated through ~2 weeks of real use (shipped as a ~30s VSCode pre-commit extension) as a comprehension/knowledge tool that eliminates the manual CTRL+F triangulation on large tangled diffs; its value is intent-clustering (not role-labeling), its unit is the semantic span (not the hunk), its grain is set by a trust-need stopping rule over a scale-free recursion, and it deliberately serves the *understanding/ownership* half of review that the market under-serves rather than the *defect* half — with the external-person test (Q3) still the open gate to "product for others."**
