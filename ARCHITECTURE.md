# Architecture

Reference for how the tool is wired today. For the *why* (the conceptual model — roles,
trust directions, the read-time-decomposition thesis) see §9 below and [`README.md`](README.md);
for usage see [`README.md`](README.md). This document is the *what and how* — mostly **diff-mode**
(the original product); codebase-mode is sketched in §0, §7, and §8.5.

> **One-line mental model:** a diff flows through a deterministic shell → a **per-pass
> classifier** (each of cluster / roles / wiring independently `det` | `llm` | `hybrid`) →
> a deterministic overlap/spans pass → a deterministic assembler → the versioned `--emit-seams`
> JSON the VS Code extension renders natively (or an ASCII/markdown text render). The tool
> **structures, it never judges.**

---

## 0. Code layout — two modes on a shared core

The tool has **two products** behind one CLI, split into loosely-coupled folders under `ts/src/`:

```
ts/src/
  core/        shared engine, knows NO mode — graph_ir (the IR), llm (claude-CLI / host-bus
               plumbing), treesitter (parsing substrate), contract (schema stamp), progress,
               resolve/ (consumers · resolver · walk · languages/ · lsp/ — the stack-specific
               resolution behind a Resolver strategy)
  diff/        DIFF-MODE — review working changes → seam model. parser · diff_source · lang ·
               symbol_edges · facts · facts_treesitter · facts_resolve · classifier_det ·
               classifier_llm · engine (per-pass orchestrator) · noise_filter · seams (assembly) ·
               report_text (ASCII/markdown render) · blast_radius · cache · subgroup · seam_types
  codebase/    CODEBASE-MODE — anchor on a symbol (or auto-select one from an intent) → intent
               FOOTPRINT (consumers + deps) → seams. scan/ (footprint build) · codebase (decompose) ·
               anchor/ (rank · intent_expand · anchor_select: probe → judge) · llm_discovery ·
               atoms (tree-sitter facts) · coupling/ (data-coupling adapters) · grow/ — the FOOTPRINT
               PROJECTIONS: orchestrate (grow the spine) + the non-spine SHAPES (project_set ·
               reach · contract · neighborhood · compare) + name_consumers (name-grounded recall) +
               route (the NL→shape router) — §8.6
  cli/         decompose.ts (the one CLI entry) · anchor_rank.ts (standalone ranker / --select)
```

**The rule (a maintained convention):** `diff/*` and `codebase/*` import only from `core/*` and within
their own folder — **never from each other**, and `core/*` imports neither. This keeps the modes
independently evolvable; adding a third mode is a new folder, no core surgery.

**The one deliberate cross-mode composition** lives at the **CLI/composition root**: `cli/review_impact.ts`
(`--review-impact`, MCP `decompose_diff impact:true`) is the *bridge* — it annotates a classified **diff**
(diff mode) with the **codebase** impact + cross-stack coupling of the changed symbols. It must sit in
`cli/` precisely because the layering forbids `diff/`↔`codebase/` imports; the bridge belongs above both,
not inside either. This is the structural embodiment of "a diff is a Δ on the codebase graph" — the
feature only Seam can build because it holds both halves on one resolved engine.

Each flag is graded by a **three-layer relevance** pipeline so it stays quiet enough to leave on (the
anti-fatigue requirement for an always-on reviewer): (1) a **deterministic floor** (`cli/review_relevance.ts`)
— written-fields ∩ read-fields, **suppress only on proof** of disjointness; whole-row/unpinnable → `unknown`;
(2) **tier** — relevant loud, unknown collapsed, irrelevant hidden; (3) **LLM triage** (`triageUnknowns`,
`--triage`, the `review-triage` strong pass) on the `unknown` residual ONLY. Same structure-proves /
LLM-judges split as the rest of the engine, applied to the output.

**Mode dispatch** lives in `cli/decompose.ts:main`: a single branch routes `--scan` / `--graph` /
`--expand-graph` to `runCodebase`, everything else (`--file` / `--git` / `--from-classified`) to the
diff path. (The Python original used a `Mode` strategy Protocol; the TS port collapsed it to the branch.)

The rest of this document details **diff-mode** (§1–§9), except **§8.5 (LLM call sites)** which maps
*both* modes. Codebase-mode shares `core/graph_ir` (the IR), `core/llm`, and `core/treesitter`, but
forks role assignment (anchor-relative BFS over a RESOLVED graph, not the `HunkFacts` ladder) — see
§8.5 and the **Codebase mode** section of [`README.md`](README.md).

### Clients & the contract boundary

The engine is a **stateless library/binary** (`ts/`). Every client is thin and talks to it only
through the `--emit-seams` JSON — that JSON, not the code, is the product boundary:

```
        Seam engine (ts/) — stateless; emits the --emit-seams JSON (versioned)
   ▲                  ▲                    ▲
 CLI (ts/src/cli)   VS Code ext       MCP server (mcp/)   … IntelliJ (future)
```

- **Contract:** `ts/src/core/contract.ts` stamps `schemaVersion`; the shape is documented in
  [`docs/SEAM_JSON_CONTRACT.md`](docs/SEAM_JSON_CONTRACT.md). Additive fields don't bump; breaking
  changes do, and clients warn on a higher major.
- **Distribution:** [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) — bun-from-source vs the esbuilt
  `ts/dist/seam.cjs` bundle (`bun run build`; web-tree-sitter kept external so it loads its own wasm —
  **not** `bun build --compile`, which drops the core wasm and aborts), the grammar caveat, the host-bus seam.
- **MCP:** [`mcp/`](mcp/) exposes **12 tools** to any agent — `decompose_diff` / `intent_footprint` /
  `grow_intent`, the structural shapes (`find_consumers` / `find_dependencies` / `impact_of` /
  `refactor_facts` / `can_reach` / `module_contract` / `subsystem` / `compare_symbols`, §8.6), and
  `ask` (the NL router).
  `det` is offline. `hybrid`/`llm` serve their LLM passes one of two ways, auto-chosen per call
  (override with `SEAM_MCP_LLM=binary|sampling`): **binary** — the engine makes its own `claude`/`copilot`
  calls (cheap dedicated tier, no sampling needed — so clients *without* MCP sampling, e.g. GitHub
  Copilot, still work as long as a CLI is on PATH); **sampling** — borrow the **caller's** model via MCP
  sampling (over the `--llm-bridge` host bus, the same seam the `seam` skill uses). `auto` prefers a
  local binary, falls back to sampling. The MCP server picks via the engine's own `--check-backend`
  probe, so backend resolution stays the engine's source-of-truth. **No daemon.**

---

## 1. Pipeline

```
                 ┌─────────────── deterministic shell ───────────────┐
  diff (file/git) → diff_source → parser → noise_filter ─────────────┐
                                  (Hunk[])   (marks noise)            │
                                                                      ▼
   ┌──────────────────── diff/engine.classify (orchestrator) ──────────────────────┐
   │  facts = FactsProvider.facts(work)   # only if any pass is det/hybrid         │
   │                                                                               │
   │   ROLES pass   → roles/role_confidence            (det | llm | hybrid)        │
   │   WIRING pass  → seam/seam_label/wires  (reads roles)                         │
   │   CLUSTER pass → group/intent           (reads wiring for det)                │
   │   SPANS pass   → placements (overlap + header peel)   [always, deterministic] │
   └───────────────────────────────────────────────────────────────────────────────┘
                                                                      │
                                              hunks (fully labelled)  ▼
                       report_text.render → ASCII/markdown      OR    seams.emit_seams_json → JSON
                       (--format ascii|llm, to stdout)             (the contract the VS Code ext renders)
```

Stages (`cli/decompose.ts` is the CLI entry):

1. **`diff_source`** — load a unified diff from `--file` or `git diff <range>` (`--repo`); synthesizes diffs for untracked files.
2. **`parser`** — split into `Hunk`s with stable ids (`h1`, `h2`, …). **The engine owns hunk-id assignment** — every other producer (incl. the VS Code extension) keys off these ids.
3. **`noise_filter`** — deterministic pre-pass marks whitespace / rename / binary / lockfile / doc / generated hunks as `noise` (the one role where determinism matters); they skip the classifier.
4. **`engine.classify`** — the per-pass classifier (§3).
5. **`assign_spans`** — deterministic overlap/header-peel (§5), always run.
6. **`seams`** (assembly) → **`report_text.render`** (ASCII/markdown), or **`seams.emit_seams_json`** for the extension. (The old self-contained HTML report was removed — clients render the JSON.)

---

## 2. Data model (`diff/parser.ts`, `diff/facts.ts`)

- **`Hunk`** — the unit of decomposition. Carries the diff text + metadata, then the labels filled by the passes:
  - `role` ∈ `core | link | environment | test | noise`
  - `role_confidence` (1.0 = certain; < 0.6 surfaces as "uncertain")
  - `group` / `intent` — cluster id + its product-intent label
  - `seam` / `seam_label` — for a **core**: its own id is the seam id, plus a technical-intent label
  - `wires` — for a **non-core**: the seam id(s) (= core hunk ids) it wires to (many-to-many)
  - `spans` — legacy per-role sub-regions from the LLM role pass (Direction C)
  - `placements` — the engine-computed **overlap** model (§5)
- **`Placement`** — one rendered sub-range of a hunk: `(seam, role, start, end)` over new-side file lines. `seam != ""` = an attachment into that seam (a link split per core, or a core placed as `link` into a sibling); `seam == ""` = the leading-ambient **header peel**. *The renderer only reads these.*
- **`HunkFacts`** — the universal IR the deterministic passes reason over (§4): `defines`, `references`, `calls`, `enclosing`, `decisions` (logic magnitude), `implements`, `is_test`, `is_sql`, `imports_only`, `type_decl_only`.
- A **seam** = one **technical intent** (one *or more* cores) + the hunks wiring it. Seam id = a representative core's id; several cores can share it. A **cluster** = a product-intent group of seams (seam ⊂ cluster). Cores are grouped into seams by `classifier_det.merge_seams` (deterministic floor: same file + enclosing component) and, in the hybrid path, `apply_seam_groups` (union of that floor with the LLM's intent grouping + shared label); the merge runs **after** clustering and unifies a seam's cores into one cluster.

---

## 3. The per-pass classifier (`diff/engine.ts`)

Three passes, each independently on one of three engines. **Order: roles → wiring → clusters → spans** (each reads the prior). `facts` is computed once if any pass is `det`/`hybrid`.

| pass | `det` | `llm` | `hybrid` | **default** |
|---|---|---|---|---|
| **cluster** (grouping) | connected components + structural label | LLM grouping + prose label | det grouping + LLM prose labels | **llm** |
| **roles** | structure + change-magnitude | LLM voting | det + LLM re-judges only the *uncertain* | **det** |
| **wiring** | subject anchoring + reconcile | LLM Pass C | **LLM-first**: LLM draws all + names seams, det grounds | **hybrid** |

**Engine choice rationale (measured, 4 shared gold cases):** roles det ≈ **0.77** vs llm ≈ 0.55; wiring det F1 ≈ **0.63** vs llm ≈ 0.24 (the llm number was role-confounded — see §9); cluster llm F1 ≈ **0.98** vs det ≈ 0.68. So: LLM where it's the only reliable engine (grouping), deterministic where it wins (roles), hybrid where the deterministic tail needs cleanup (wiring of tangled diffs).

Special case: **all-LLM** (`cluster=roles=wiring=llm`) routes to `classifier_llm.classify_all_llm` (cluster ∥ roles concurrently, then wire pass) for its speed optimization, then runs `assign_spans`.

`--classifier X` is a preset that sets all three; a per-pass flag overrides it. `--classifier det` = fully offline (no LLM).

### 3a. ROLES (`classifier_det.assign_roles` / `classifier_llm.assign_roles`)

Deterministic ladder over `HunkFacts` (in order): `is_test` → `is_sql`→env → import-only / type-decl-only → env → `implements`→link (adapter) → then the **core/link** call from change-magnitude (`decisions`) + def↔use direction (defines-a-used-symbol = core; references-one = link). `role_confidence` is the heuristic's margin. `hybrid` re-judges only `< 0.6`-confidence hunks with the LLM. **Validated-safe rules only** (e.g. `implements`→link, `.sql`→env each co-occur with a single gold role); the `logic==0 ⇒ env` demotion was tried and reverted (it killed logic-less React cores).

### 3b. WIRING (`classifier_det` + `classifier_llm.reconcile_llm`)

- **`det`**: subject-anchored wiring (`_subject_wiring`) — a non-core hunk wires to every core whose **distinctive subject** it mentions (a core's subject = its defs + the modified enclosing symbol + its call/JSX subjects). Distinctiveness drops ambient symbols (frequency cut) and **shared imported chrome** (symbols imported-from-outside the diff used in ≥3 hunks — `Button`, `useLocale`). Then `reconcile_wiring` (tier-2, deterministic): on an over-wired hunk (> 4 cores) keep only edges to cores it *owns* a symbol of; a hunk with **no owned edge is a legitimate hub** (header/barrel) → left alone.
- **`llm`**: `classifier_llm.assign_wiring` (Pass C) — fragile standalone, kept for completeness.
- **`hybrid`** (default, **LLM-first**): the LLM **draws every non-core hunk's dependency line by meaning** *and* **names every seam** (technical intent) in one call, with the deterministic symbol candidates passed only as a **hint**. Then determinism **grounds** it: `h.wires = LLM_drawn ∪ det_owned` (re-add owned-symbol edges the LLM missed); no LLM list for a hunk → keep the deterministic candidates. This is the inversion: *LLM draws, determinism checks* — meaning over symbols, with symbol grounding as the safety net.

### 3c. CLUSTERS (`classifier_det.assign_clusters` / `classifier_llm.assign_clusters`)

- **`det`**: connected components over the wiring graph; `intent` is a structural label (the cluster's core symbol via `_primary_symbol`, which prefers a Component/Type name over a destructured local).
- **`llm`** (default): LLM grouping + product-intent prose.
- **`hybrid`**: det grouping + LLM prose labels.

---

## 4. The Facts IR & producers (`diff/facts.ts`, `diff/facts_treesitter.ts`)

The deterministic passes contain **zero regex / language knowledge** — they read `HunkFacts`. A `FactsProvider` produces them; swap the provider to change the syntax source. Two producers are *correct iff they emit equal `HunkFacts`* — the contract that makes "tree-sitter ≡ VS Code AST" a test, not a hope.

- **`RegexFactsProvider`** — the generic fallback (regex over diff text; comments/strings masked for logic-side facts). Works degraded on any language.
- **`TreeSitterFactsProvider(file_source)`** — full-file AST (optional `tree_sitter_language_pack`); parses the post-image file, masks comment/string nodes, scopes to the hunk's changed lines, reuses `facts_for_hunk`. **Alignment-guarded** — if the working tree doesn't match the diff (wrong commit) it falls back to regex per hunk; never trusts a misaligned parse.
- **`ExternalFactsProvider(payload)`** — consumes a `HunkFacts` payload computed *outside* Python (the VS Code extension's language-server facts). Per-hunk regex fallback.
- **`MergedFactsProvider(base, payload)`** — overlays a *partial* external payload (only the fields a source can fill, e.g. VS Code DocumentSymbols → `defines`/`enclosing`) onto a base provider.
- **`ResolvedFactsProvider(base, repo)`** (`diff/facts_resolve.ts`) — base facts (regex) **plus** codebase-resolved out-of-diff refs grounded to in-diff cores (`--facts-engine resolve`).
- **`FileSource`** — `RepoFileSource` (working tree) / `DictFileSource` (fixtures). Full-file granularity is what makes tree-sitter ≡ VS Code provable.

Shared helpers: `facts_from_texts` (assembly given raw + masked text — same for every producer), `changed_newside`, `facts_for_hunk` (full-file slice + alignment), `leading_ambient_lines` (the header-peel signal used by spans).

Underneath sit the low-level deterministic signals: **`lang`** (symbol extraction — defs/refs/imports/call-subjects, the swap point), **`symbol_edges`** (`candidate_wirings` def↔use floor, `external_refs`, `rewire_pairs`, alias resolution), **`noise_filter`**.

---

## 5. SPANS / OVERLAP (`classifier_det.assign_spans`)

Deterministic, engine-agnostic, **additive** (never touches role/seam/wires — so the role/wiring golds are unaffected). Fills `Hunk.placements`:

- **Peel** — a fused core/link that opens with an import/decl header gets an `environment` placement over that header (so the leading imports don't read as part of the logic).
- **Core→sibling (the overlap)** — a core whose body references *other* cores' distinctive symbols is placed as a `link` sub-range into each sibling's seam, while staying whole/`core` in its own seam. *A line's meaning is seam-dependent.*
- **Link split** — a link/env wiring several cores splits into the per-core region wiring each (alias/wrapper resolved against the working-tree file when `--repo` is given).

The renderer and the extension **read** placements to draw split gutter bars / per-seam sub-ranges.

---

## 6. Output surfaces

The self-contained HTML report (cytoscape + diff2html) was **removed** — clients render the JSON. Two surfaces remain:

- **Text report** (`report_text.render`) — an ASCII / markdown seam tree to stdout (`--format ascii|llm`); spans/placements applied, per-seam *look-here* flags (isolated-core / dangling-link / uncertain / untested-core).
- **Seam JSON** (`seams.emit_seams_json`) — the contract for every client: `{clusters:[{intent, seams:[{label, linkOnly, uncertain, warnings, hunks:[{id,file,start,end,role,confidence,external,externalRefs,rewire}]}]}], tests, noise}` (codebase mode adds `resolutionQuality`, `unresolved`, `blindspots`, `autoGrown`). Stamped with `schemaVersion` by `core/contract.ts`.
- **VS Code extension** (`vscode-extension/`) — consumes `--emit-seams` and renders *natively*: per-seam role gutter bar (split where placements overlap) + scrollbar map + seam tree + CodeLens labels; lazy external-coupling resolution via the editor's go-to-definition. It also *produces* facts: `facts.ts:computeSymbolFacts` walks DocumentSymbols → a partial `HunkFacts` payload, passed back via `--facts`. Setting **`seam.engine`** = `hybrid` (default → `--cluster llm --roles det --wiring hybrid`) | `det` (offline) | `llm`. *(Build with `bun run compile` — bun, not npm.)*

---

## 7. CLI (`cli/decompose.ts`)

- Source: `--file` | `--git <range> --repo` | `--from-classified <json>` (re-render a dump, no LLM).
- Engines: `--cluster/--roles/--wiring {llm,det,hybrid}`, or `--classifier {llm,det,hybrid}` (preset).
- Facts: `--facts-engine {regex,treesitter,resolve}`, `--facts <json>` (external), `--emit-hunks <json>` (parse-only skeleton for an external producer).
- Output: `--format ascii|llm` (text to stdout) | `--emit-seams <json>`; `--dump-classified <json>` (the post-classify intermediate state, re-renderable). `--format html` is a clear error (HTML removed).
- Codebase mode: `--scan --anchor-file <f> [--symbol <s>]`, `--graph`/`--expand-graph`, `--auto --intent <q>` (auto-grow; auto-anchor when `--symbol` is omitted), `--grow det|llm`, `--data-coupling off|floor|llm`, `--bidirectional`, `--llm-bridge <dir>`.
- LLM: `--model`, `--claude-bin` (auto-detects `claude`, falls back to `copilot`).

---

## 8. Evaluation (`ts/eval/` + `ts/test/`)

- **`ts/eval/harness.ts`** — the regression gate. `generate --engine {det,llm}` runs each gold case (det once, llm N×, cached under `ts/eval/_runs/`) → `score` computes **stability**, **accuracy** vs `ts/eval/gold/`, and **health**. Gates on N-run aggregates with tolerance against a baseline saved with `--save` / checked with `--baseline`. Wiring is scored by **seam-granular precision-weighted Fβ(0.5)** (a false coupling hurts a reader more than a missing one; seam-granular avoids the seam→core expansion artifact) — the old edge-recall **wiring F1 is kept for context but no longer gated**. Health's **over-wiring** (`over_wired` / max·mean seams-per-hunk) is the gated reading-failure signal; **isolated-cores / dangling-links / orphans are informational postures, NOT errors** (a dangling link may point at existing/external code, an isolated core may be a self-contained refactor) and are never gated. Optional `ts/eval/sentinels/<case>.json` lists must-have couplings (e.g. the informal JNI edge a symbol scan can't see) as an under-wiring guard.
- **Unit suites** (`ts/test/*.test.ts`, run with `bun test`): `extraction.test.ts` (deterministic signals — external/rewire/alias/segmentation), `facts.test.ts` (the provider contract — round-trip, `external ≡ regex`, merge, fallback), `treesitter.test.ts` (comment/string masking, clean-code equivalence, fallback, alignment guard), `seams.test.ts` / `classified.test.ts` (assembly + spans/overlap), `hybrid.test.ts`, `wire_barrier.test.ts` / `wire_resolve.test.ts`, `cache.test.ts`, `blast_radius.test.ts`.
- **codebase-mode** — `codebase.test.ts` (anchor-relative roles → seams on a fixture graph), `resolver.test.ts` (the Resolver strategy + real-LSP integration), `import_scan.test.ts`, `orchestrate.test.ts`, `anchor_rank.test.ts`, `data_coupling.test.ts`, `phase4.test.ts`. Tests that spin up real language servers are guarded so the default `bun test` stays offline.
- **`ts/eval/gold/`** — hand-agreed labels, **12 cases across TS / Java / Ruby / C / C++** (e.g. `calcom-webhooks`, `zod-superrefine-when`, `spring-datasource-lazy`, `godot-canvas-oversampling`, `redis-rax-findlink`, `psdk-*`). Some are drafts pending audit; the symbol-derived wiring gold is over-dense in places, so it under-scores meaning-based wiring (rework in progress).

---

## 8.5 LLM call sites (both modes) — the complete map

Every LLM call funnels through `core/llm.ts`: `resolve_backend()` (picks claude→copilot, or `("host","")` when a `HostBus` is installed) → `run_pass()` (the facade — one pass, one retry, JSON-array parse) → `runPassRaw()` → `_run_claude()` / `_run_copilot()` (the `spawnSync`). Both diff-mode and codebase-mode passes call `run_pass(prompt, {tag})`. **One interception point covers everything** — installing a `HostBus` (`set_host_bus`) makes `resolve_backend` return `("host","")` so *all* of these route through the running session / a subagent instead of a subprocess, in **both** modes, with no binary lookup (see `--emit-prompts`/`--inject-llm`, `--llm-bridge`, and `.claude/skills/seam/`).

`thinking` is the per-call `MAX_THINKING_TOKENS` budget (0 = off/fast; a positive int caps it; ON is reserved for grouping). Every codebase-mode pass degrades to the deterministic floor on `ClassifierError` (`LLMError`).

### DIFF mode (`diff/`)

Passes run in order **roles → wiring → clusters → spans** (`engine.classify`). Default engine = `cluster=llm roles=det wiring=hybrid` (what the VS Code extension sends).

All sites are in `diff/classifier_llm.ts`.

| # | pass (function) | `tag` | thinking | in the **default**? |
|---|---|---|---|---|
| 1 | **wiring** reconcile — `reconcile_llm` | `reconcile` | 0 | ✅ **yes** (wiring=hybrid; only if ≥1 core) |
| 2 | **cluster** — `assign_clusters` | `cluster` | 2048 | ✅ **yes** (cluster=llm) |
| 3 | **roles** voting — `assign_roles` | `role` / `role.vN` | 0 | ❌ only if `roles=llm` (N-vote self-consistency) |
| 4 | **roles** reconcile — `reconcile_roles_llm` | `reconcile-roles` | 0 | ❌ only if `roles=hybrid` (re-judges `<0.6`-confidence) |
| 5 | **wiring** Pass C — `assign_wiring` | `wire` | 0 | ❌ only if `wiring=llm` |
| 6 | **cluster** labels — `label_clusters_llm` | `label-clusters` | 2048 | ❌ only if `cluster=hybrid` |
| 7 | **review-impact triage** — `triageUnknowns` (`cli/`) | `review-triage` | 0 | ❌ only `--review-impact --triage` (LLM-judges the `unknown` relevance residual) |
| — | **all-LLM fast path** — `classify_all_llm` (cluster ∥ roles, then wire) | `cluster`,`role`,`wire` | mixed | ❌ only if `cluster=roles=wiring=llm` |

So the **default diff run makes exactly 2 LLM calls**: `reconcile` then `cluster`. `roles`/spans are deterministic.

### CODEBASE mode (`codebase/`)

CLI default = the **deterministic floor** (anchor → footprint → intent floor): `--classifier` is unset, so `useLlm` is false and the LLM is off. **The VS Code extension opts in** — its codebase scan sends the `seam.engine` setting (default `hybrid`) as `--classifier hybrid`, and codebase mode treats `hybrid`≡`llm` (`useLlm = classifier ∈ {llm, hybrid}`, no per-pass split), so a default extension scan **does** run `seam-refine` (and `seam-intent`/`relevance` too, but only when an `--intent` is given). All calls go through `run_pass`.

| pass (function) | site | `tag` | gated by | what it does |
|---|---|---|---|---|
| **intent expand** — `expand_intent_terms` | `intent_expand.ts` | `expand` | auto-anchor selection (`--auto`, no `--symbol`) | proposes identifier-style recall keywords so the morphological candidate scan reaches *register* from *"registration"* (grounded by the scan; graceful `[]` offline) |
| **anchor judge** — `judge_anchor_llm` | `anchor_select.ts` | `anchor-judge` | auto-anchor selection (≥2 connected candidates) | picks WHICH probed footprint is the intent's entry point — the semantic call structure can't make (a data-heavy helper out-crosses the real gate) |
| **seam refine** — `refine_seams_llm` | `codebase.ts` | `seam-refine` | `useLlm` (`--classifier llm\|hybrid`) | F4: refines the deterministic floor into named technical-intent seams (a *proposed* partition over verified carriers; never invents an edge) |
| **seam intent / relevance** — `label_focus_relevance_llm` | `codebase.ts` | `seam-intent` | `useLlm` **and** `--intent` | F5: labels + TIERS each seam spine/supporting/off and marks the answer seam, primed by topology + db-table priors (additive — dims, never drops) |
| **residual discovery** — `discover` / `discover_keys` | `llm_discovery.ts` | `discover` / `discover-keys` | `--data-coupling llm` / tier-3 DOWN-expansion | proposes residual couplings (or shared-key boundaries) the deterministic scan missed → SUGGESTED edges |
| **auto-orchestrate** — `auto_orchestrate` | `orchestrate.ts` | `orchestrate` | `--auto --grow llm` | legacy LLM grow: the LLM picks the next node + direction; default `--grow det` (`grow_to_terminals`) follows crossings to terminals with **no** LLM |
| **shape route** — `routeQuestion` | `grow/route.ts` | `shape-route` | `--ask "<q>"` | the router (§8.6): JUDGES which shape answers the NL question + extracts the target name(s); the only LLM in the `--ask` path (the shape it picks then runs deterministically) |

**Auto-anchor selection (`codebase/anchor_select.ts`).** When `--auto` is given an `--intent` but **no `--symbol`**, the engine chooses the anchor instead of the user: `find_anchor_candidates` + `rank_anchors` (name-overlap recall, widened by the `expand` pass) → a shallow deterministic `grow_to_terminals` **probe** of each top-K candidate → drop the ones whose footprint dead-ends (the structural floor: `reach`/`crossings`/`terminals`) → the `anchor-judge` LLM picks the connected footprint that answers the intent. Same split as the rest of the system: **structure measures connectedness (a fact), the LLM judges relevance (the meaning)** — so a name-matching-but-isolated symbol can't be picked and hide the real result. Degrades to the structural-best pick when no model is available.

**The codebase invariant (`core/llm` docstring):** the LLM here only produces a *proposed partition / labels / suggestions / an anchor choice* over **resolved** carriers — it never finds an atom or an edge (those are deterministically resolved), so a mis-frame can't make the map lie.

---

## 8.6 Codebase shapes — projections over the resolved graph + the router (`codebase/grow/`)

The flow/spine is **one** shape of answer; it is not the unit. The unit is the **`ResolvedGraph`**
(`scan/graph.ts`) — resolved edges (imports, namespace-member calls, data-coupling shared-keys, HTTP
routes). A *spine* is the longest-meaningful-path **projection** of it; a *policy* is the star/fan
projection. The non-spine **shapes** are sibling projections of the same graph, each a small module in
`codebase/grow/`:

| shape (`--query`) | module · fn | projection | honest negative |
|---|---|---|---|
| **consumers** | `project_set.projectConsumerSet` | the anchor's resolved **in-edges**, tier-sorted (FULL → PARTIAL → SUGGESTED) | `noStructure` (`opaque` = callers exist but unresolved → grep; `none` = no caller) |
| **dependencies** | `project_set.projectDependencySet` | the anchor's resolved **out-edges** (DOWN footprint) — the symmetric inverse, shares `projectEdgeSet` | `noStructure` (`none` = a leaf; `opaque` = deps don't resolve) |
| **impact** | `impact.projectImpact` | the **transitive** consumer closure (bounded BFS up), rolled up by file, + the `surface` (leaves of the up-tree) + `gaps` (opaque callers) | `noStructure` (`isolated` = no consumer; `opaque` = only opaque callers) |
| **refactor** | `refactor_facts.gatherRefactorFacts` | a COMPOSITION (not a projection): impact + dependencies + contract gathered SEQUENTIALLY (build_footprint isn't concurrency-safe) for "how to refactor X" | — (delegates to its parts; the PLAN is the LLM's, never emitted) |
| **reaches** | `reach.findReach` | bounded BFS over **down** footprints A→B + a witness path | `unreachable` (closure drained) vs `exhausted` (budget — inconclusive) vs `no-out-edges` |
| **contract** | `contract.projectContract` | module **boundary** — used exports + consumers (in-cut), dead exports, resolved imports (out-cut), fan-in/out | `noStructure` (no exports) |
| **neighborhood** | `neighborhood.projectNeighborhood` | a bounded local ball + the **weak-community** core/periphery split (file core iff internal-edges ≥ external — parameter-free, deterministic) | `noStructure` (isolated) |
| **compare** | `compare.projectCompare` | set-diff of two anchors' **dependency** sets (shared / A-only / B-only) + Jaccard | `noStructure` (neither has deps) |

**The discriminator** (the whole reason these belong to Seam and not grep/RAG): *not* "is it a flow"
but **"does the answer's correctness need resolved edges?"** Lexical one-fact → grep; semantic
*about-X* → RAG; Seam owns the **structural middle**. Every shape carries the **dual of `noFlow`** — an
explicit `noStructure` that **routes away** rather than fabricating a result. They are deterministic,
offline, and reuse the scan wholesale (each is a projection + a renderer, not a new engine), so they
add zero risk to the spine/grow path.

Two notes that bit real repos and shaped the code:
- **Resolver floor completeness, not embedding fallback.** A consumer the floor misses is a *resolver*
  gap to fix. Two were: **namespace-member calls** (`const ns = await import(...)` then `ns.fn()`,
  resolved through a re-export barrel — `core/resolve/consumers.ts` + a `namespaceImports` provider
  method, kept out of the `ImportRef` stream so dep-graph/oracles are untouched), and a **name-grounded
  recall** tier for languages with no symbol imports (Ruby globals are `constant` AST nodes; C/C++ have
  no `#include` parser) — `scan/name_consumers.ts`, opt-in `--recall name`, kept in a **separate**
  `recalled` list (never the verified members), file-deduped, labelled UNVERIFIED.
- **`build_footprint` is not concurrency-safe** (shared module-global scan caches). The shape collectors
  expand **sequentially** (`reach`/`neighborhood` loop with `await`; `compare` deliberately *not*
  `Promise.all` — concurrent collection corrupted results).

### The router (`grow/route.ts`) — the semantic front door

`--ask "<question>"` (MCP `ask`) turns a natural-language question into a run shape. The split is the
project's invariant applied to routing itself:

1. **`SHAPES` registry** = the source of truth (id · `needs` · hint). The router prompt is **built from
   it** — adding a shape updates routing automatically; no hardcoded list to drift (CLAUDE.md: a closed
   STRUCTURAL set comes from the registry, never a hand-synced list).
2. **`routeQuestion`** = one LLM pass (`shape-route`, §8.5) that **judges** the shape and extracts the
   target name(s) — semantic, never keyword-matched. *(Framework note: `_collect` keeps only items with
   an `id`, so the chosen shape is emitted as the `id` field.)*
3. **`resolveName`** = a **deterministic** def-lookup (`enumerate_defs`) name→file, test-demoted,
   ambiguity-flagged — the structural half.
4. **`ask`** = route → resolve → run; dispatches to the five shapes + `flow` (grow + decompose), and
   routes **away** to `grep` (lexical) / `rag` (semantic) as an honest decline. Guard: `get_host_bus()
   || available()` — `available()` alone misses the MCP sampling bridge and would wrongly reject it.

So `ask` is the realization of the "turn `noFlow` into shape-dispatch" idea: every codebase question
has a home, and Seam says so when the home is grep or RAG rather than itself — which is what makes
redirecting *to* Seam trustworthy.

---

## 9. Key decisions & rationale (the load-bearing "why")

- **Deterministic-first, LLM on the residual.** Roles + wiring are deterministic (better, instant, reproducible); the LLM is spent only where it's the reliable engine (grouping) or where determinism's tail fails (over-wired containers).
- **Wiring's real bug was extraction, not roles.** Anchoring only on *newly-defined* symbols missed cores that *modify* existing ones; anchoring on a core's full **subject** lifted det wiring F1 0.13 → 0.63. Shared imported **chrome** (Button/useLocale) caused the cal.com hairball → dropped from anchors.
- **"LLM-first wiring is bad" was a measurement artifact** — the ~0.24 A/B ran LLM *roles* too (wiring is role-dominated) and the standalone Pass C was prompt-fragile. Given a good draw prompt the LLM wires fine, which is what makes the LLM-first hybrid sound.
- **Hubs vs containers.** A header/barrel with many *correct* edges looks "over-wired" by count; it's protected (no owned edge ⇒ not pruned/escalated). The inverted draw is hub-safe (LLM keeps real relations; det grounding re-adds owned edges).
- **Facts IR isolates language-specificity** to one swappable producer — the honest path to tree-sitter / VS Code AST without touching the classifier (§4).

### Known limits / open

- Vocabulary-saturation diffs (one feature, shared domain vocab) remain hard deterministically — the Layer-2/LLM case.
- Wiring **gold is being reworked** (symbol-derived, over-dense) so the LLM-first wiring can be measured honestly.
- VS Code AST producer is validated against the facts-provider contract; the extension's live AST path still needs F5 validation.
- **Codebase-mode** (non-diff: anchor → footprint) is **now built** (`ts/src/codebase/`, §0) — no longer out of scope. It shares `core/` but forks role assignment; its language/stack resolution is externalised to real LSP servers behind a Resolver strategy (`core/resolve/lsp/`, `core/resolve/languages/`).
- **Auto-anchor** (intent → selected anchor) is recall- and judgement-bound: the structural probe reliably discards dead-end anchors, but the candidate pool is bounded by the name-overlap scan + LLM query-expansion, and the final pick is an LLM judgement (`--symbol` skips it). See `codebase/anchor_select.ts`.
