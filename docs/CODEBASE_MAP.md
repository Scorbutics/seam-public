# Codebase map — onboarding

One-page orientation for owning this codebase. Read `ARCHITECTURE.md` first for the concepts (seams,
roles, tiers, provenance); this doc is the "where do I look" companion — the actual directory layout,
in dependency order, with what each piece is for and its rough size.

Dependency direction is enforced by `test/architecture.test.ts` — nothing below may import from
something above it in this list.

## 1. `core/` (1.3k lines) — language-agnostic primitives, no product logic
The floor everything else stands on. `graph_ir.ts` (nodes/edges/provenance/DSU), `dispatch.ts` (the
generic ancestor-chain walker every language's method-lookup binds to), `treesitter.ts` (grammar
loading), `resolution.ts`, `contract.ts`, `llm.ts` (the one place that shells out to a model).

`core/resolve/languages/` is the **registry** — one `LanguageProvider` object per language
(extensions, resolve, imports, tableAccess, handlerFileConvention, carrierEngine, …). This is the
single source of truth the CLAUDE.md "never hardcode a parallel list" rule points at. New language
support starts here.

## 2. `languages/{typescript,java,ruby,python}/` — per-language adapters, deliberately thin
Each language folder implements the registry interface for that language: `resolve.ts` (binds to
`core/resolve`), plus whatever's genuinely language-specific (`typescript/jsx.ts` for JSX consumer
feeds, `ruby/dispatch.ts` for mixin-aware ancestor lookup, `ruby/carrier.ts` for `.rb`/`.rake` DSL
walking). If you're tempted to add a language-specific `if (file.endsWith(...))` anywhere else in the
codebase, it almost always belongs here instead.

## 3. `codebase/anchor/` (0.5k) — pick the starting node
Given a symbol or an intent string, resolve it to a concrete anchor node to grow from. Only place that
touches embeddings for *selection* (see `INTENT_RELEVANCE.md`) — everything downstream of the anchor is
structural.

## 4. `codebase/scan/` (3.2k) — build the graph
Parses files into defs/units, builds the call graph, dependency graph, interface↔impl index,
consumer graph, string-based dispatch resolution. This is where a file becomes graph nodes and edges.
`detect.ts` holds the blindspot/subcore/contract/consumer-feed detectors extracted from `codebase.ts`.

## 5. `codebase/grow/` (2.9k) — the footprint walk
`orchestrate.ts` is the core loop (start here, it has a glossary block at the top for the I1–I7
invariant shorthand used in comments). Grows a footprint outward from the anchor along already-resolved
edges only — **intent-free and embedding-free by design** (see CLAUDE.md's GROW invariant); intent only
crops/ranks the result afterward, never steers the walk. `border_policies.ts` is the hub/ubiquity
classifier extracted out of the main loop.

## 6. `codebase/coupling/` (3.3k) — the data-flow boundary
Follows a flow across a boundary the call graph can't see: HTTP routes, db tables, queues, shared keys.
`index.ts` is the entrypoint; `adapters/` are per-boundary-kind matchers (http_route, etc.);
`llm_key_index.ts` + `key_matcher.ts` are the "teach once, cache, apply deterministically forever"
flywheel — read `teacher-architecture` context before touching this if you have access to prior project
memory, it explains why the LLM only runs once per framework, not per query.

## 7. `codebase/render/` (0.7k) — shared rendering vocabulary
`vocab.ts` (this file) is the one seam-rendering language (`where`/`rolesOf`/`facts`/`memberLines`/
`buildNodeIndex`) every view below reuses instead of re-deriving its own. `medium_registry.ts` classifies
coupling mediums. `shapes.ts` renders the 8 structural query shapes (consumers/dependencies/impact/...).
`region_views.ts` renders the flood/wave/scenario views. `llm_context.ts` (at `codebase/`, not
`render/`) holds the two most elaborate views — `renderAgent` and `renderConcern` — because they're
still genuinely entangled with assembly-core internals (documented, not an oversight).

## 8. `cli/` (2.2k) and `diff/` (3.3k) — the two entrypoints
`cli/decompose.ts` is the CLI surface for **codebase mode** (grow/query/render from an anchor or
intent) — see `VIEW_RENDERERS` and `QUERY_HANDLERS` maps near the top for the full list of `--format`
and query flags. `cli/queries.ts` holds the 9 query-shape handlers. `diff/` is the separate,
mostly-sync **diff mode** (decompose a git diff into seams) — `engine.ts`'s header comment explains the
det/hybrid/llm axis per pass (roles/wiring/cluster) with worked examples.

## Walking a real flow instead of reading files cold

Rather than reading every file above top-to-bottom, trace one real flow with Seam on itself. Example
run against this repo, anchored on `renderAgent` (the `--format agent` view):

```
intent_footprint(repo, anchorFile="ts/src/codebase/llm_context.ts", symbol="renderAgent", engine="det")
```

What it showed: `renderAgent` is a `core` node, called from exactly one production site
(`cli/decompose.ts:54`, inside the `VIEW_RENDERERS` map) plus its own test file
(`test/grow/agent_render.test.ts`) with 23+ direct calls. It also flagged an honest **blindspot**: 14
call sites load view renderers via *dynamic* `import()` (in `decompose.ts` and `queries.ts`), which a
static reference resolver can't follow — Seam surfaces these as `SUGGESTED` candidates instead of
silently missing them or asserting a fake edge. That blindspot is itself a good first lesson in the
codebase's philosophy: prefer an honest "I can't see this" over a guess.

Use the same pattern (`intent_footprint` for a known anchor, `grow_intent` for an unknown one) whenever
you're about to touch a flow you haven't mapped yet — it's faster and more reliable than reconstructing
it from memory or grep.
