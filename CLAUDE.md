Reuse the existing components before trying to create new ones.

Isolate every language specific code into their dedicated folder.
Keep the language specific and framework specific code very small.

We need to support at minimum those languages:
 - Typescript
 - Java
 - Ruby
 - C
 - C++
when doing a change.

Always favor refactoring of similar existing code / components / algorithm before starting to write new code. It of course only applies if something is already existing.

Semantic vs structural — never confuse them:
 - A SEMANTIC judgement (understanding natural language: an intent, a goal, a direction, "what does the user mean") belongs to the LLM or embeddings. NEVER keyword-match / regex / string-parse free text in the engine to approximate meaning — it dies on typos, other languages, and indirect wording. If a real signal isn't available, accept it as non-deterministic (delegate to the model) rather than faking determinism with a brittle proxy.
 - A STRUCTURAL classification (a known, closed set: node kinds, edge kinds, roles, languages) is deterministic — but source it from the registry / source-of-truth, never a hardcoded list that has to be kept in sync.

Deduce, don't guess — propagate from GROUNDED data (the core engine philosophy). When the engine must KNOW
something it can't read at the site — is this a data-coupling edge? what external layer is this receiver? what
does this wrapper ultimately do? — DEDUCE it by propagating a small set of GROUNDED facts along relations that
are ALREADY resolved. Not by name/keyword heuristics, not by defaulting to the LLM, not by blindly resolving a
call. The four invariants, in order:
 - SEED on grounded, CLOSED facts — a runtime/platform primitive, a node_modules import, a registry node-kind —
   never a generic name. `fetch` / `localStorage` / `fs` / a `@Entity` are grounded sinks; `http` / `get` /
   `save` / `*Service` / `*Repository` are NAME GUESSES. A function that CALLS `fetch` does HTTP; a function
   NAMED `getHttp` that touches no sink does not. The structural blindspot test ("would this be opaque to the
   resolver?") is the canonical seed: couple only what the static graph CAN'T already follow.
 - PROPAGATE transitively over edges that ARE resolved (calls, aliases, assignments the graph already follows)
   and HALT at the grounded boundary (the external sink, the repo edge). Never blind-resolve a call site to
   manufacture a fact; an in-repo wrapper is followed THROUGH to the real boundary, not flagged itself.
 - Apply the LLM/embeddings ONLY to the irreducibly SEMANTIC residue — what a name MEANS, which grounded
   candidate the dev intends, an opaque key — LAST, and SCOPED to a question the deduction has already framed.
   Never to DECIDE what structure can deduce; never as a blanket fallback; once per closed candidate set, cached.
 - Make it GENERAL — one mechanism per concept, serving every boundary kind (http / store / db / file / queue)
   from its own grounded seed, not a per-case hack.
This is the structural↔semantic rule in MOTION: STRUCTURE deduces the FACT (this IS an edge / a boundary), the
model only judges the MEANING (which key, which intent). If a change pushes "everything to the LLM", matches a
keyword, or blind-resolves to fabricate an edge, it violates this — redesign it as grounded propagation.

The GROW is INTENT-FREE and EMBEDDING-FREE — this is a hard invariant, not a preference. The wave/footprint is
purely STRUCTURAL (resolved edges, grounded boundaries, deterministic containment) so a node's footprint is
CACHEABLE PER FILE and REUSABLE across every intent (the graph-node cache: one materialised structural footprint,
many questions). The moment intent or embeddings enter the grow, the result becomes per-intent and the per-file
cache can no longer be materialised — it collapses. So intent/embeddings apply ONLY at RENDER time: they CROP,
RANK, and dim the already-grown structural footprint, never steer the walk. (This supersedes any earlier wording
that applied embeddings "inside" a grow decision — inside the grow, selection among candidates must be
DETERMINISTIC and STRUCTURAL.)

In plan and agent modes, do not hesitate to ask questions if you need more information, in particular for huge complex tasks.

For the architecture / high complexity code related tasks, behave like a Senior Software engineer / an architect.

Challenge the solutions I am proposing (if there is an existing better way, don't challenge everything for the sake of challenge...).

Every behavioural fix ships with a committed regression test — not just ad-hoc validation:
 - Validating a fix by running a throwaway synthetic repo is the RIGHT way to confirm it, but it doesn't count as done. Turn that same scenario into a committed test so the bug can't silently come back. If I claim a fix works, there should be a test proving it.
 - Make the test HERMETIC: a throwaway tmp (git) repo built in `beforeAll` and removed in `afterAll` — never depend on the real repo or a fixture outside the test. Mirror the per-module layout (`test/<module>/`).
 - Assert BEHAVIOUR or a STRUCTURAL contract (the bean is reached; the adapter declares `handlerEdge`), not internal counters/diagnostics. Diagnostic-only output (timing, progress, debug dumps) needs no test.
 - GUARD on optional capabilities: a test needing tree-sitter (`available()`) or embeddings/transformers must early-return when absent (offline CI / the .vsix), so the suite stays green everywhere — exactly as the engine degrades.

Using Seam to navigate code (dogfood it):
 - When you need to understand how a feature/flow WORKS across multiple files, where a flow ends/culminates, or the blast radius of a change, call Seam (the `seam` skill, or the MCP `grow_intent`/`intent_footprint` tools) instead of stitching it together by hand. Prefer ONE Seam run over 4+ iterative greps to reconstruct a flow, and call it to MAP a flow before editing across it.
 - Use grep/LSP — NOT Seam — for a single symbol lookup, find-usages, or any one-fact answer: they are instant. The tell is the answer's shape: a list of locations → grep; a path/flow/structure with a beginning and end → Seam. Seam to MAP, grep to DRILL. Seam returns `noFlow` when the intent is computation/strategy with no traceable spine (then read the touchpoints, don't expect a path).
 - DEFAULT to passing the anchor you already have. If you've already located a candidate symbol/file (you usually have — a couple of orienting greps or reads), PASS it as the anchor (`grow_intent` with `symbol`, or `--auto --symbol`): Seam then SKIPS anchor selection and just traces + decomposes from it (~11s vs ~28s for auto-anchor), and your context-informed pick is usually as good as Seam's. So the pattern is: grep to ORIENT (find one candidate), then Seam to TRACE+DECOMPOSE from it. Omit the symbol (auto-anchor) ONLY when you genuinely don't know where the flow starts.
 - USE SEAM FOR INTERNAL PLANNING BEFORE IMPLEMENTING, not just for answering questions. Discriminator = the change touches a LOGIC/DATA FLOW (a spine: fetch → transform → render → mutate) you haven't mapped AND understanding it takes **2+ symbol-discovery greps/reads across files** → call Seam FIRST (orient grep → `grow_intent` from the anchor) → a verified spine + blast-radius, then implement against the map. Cheaper/more reliable than reconstructing it on an expensive model (Seam's passes are cheap, dedicated, thinking-off). NOT for presentation/display-only changes (layout, styling, copy, a component's visuals) — few-file, non-logic, NO spine; Seam returns `noFlow`, so grep/read them. File-count alone doesn't trigger Seam — a flow to trace does.
 - PREFER the engine's `claude -p` path when a `claude` binary is available — it serves Seam's passes on the right cheap tier (haiku/sonnet) thinking-OFF, deterministically; the host-subagent skill path inherits the session (often Opus) tier and can't disable thinking, so it's slower/pricier. Dedicated cheap passes > Opus subagents.
