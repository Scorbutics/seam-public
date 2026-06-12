# Architecture

Reference for how the tool is wired today. For the *why* (the conceptual model — roles,
trust directions, the read-time-decomposition thesis) see `decomposition-model-and-mvp.md`;
for usage see `README.md`. This document is the *what and how* — mostly **diff-mode** (the
original product); codebase-mode is sketched in §0 and detailed in the plan docs.

> **One-line mental model:** a diff flows through a deterministic shell → a **per-pass
> classifier** (each of cluster / roles / wiring independently `det` | `llm` | `hybrid`) →
> a deterministic overlap/spans pass → a deterministic renderer (HTML report or the VS Code
> native surface). The tool **structures, it never judges.**

---

## 0. Code layout — two modes on a shared core

The tool has **two products** behind one CLI, split into loosely-coupled folders:

```
src/
  core/        shared engine, knows NO mode — graph_ir (the IR), llm (claude-CLI plumbing),
               treesitter (parsing substrate), mode (the strategy Protocol + dispatch)
  diff/        DIFF-MODE — review working changes → seam report. parser · diff_source · lang ·
               symbol_edges · facts · facts_treesitter · classifier(_det) · engine · noise_filter ·
               seams (assembly) · report_html/ (HTML) · run (the DiffMode strategy entry)
  codebase/    CODEBASE-MODE — anchor on a symbol → intent FOOTPRINT (consumers + deps) → seams.
               import_scan (scan) · codebase (decompose) · expand · anchor_rank · orchestrate ·
               resolver · atoms (tree-sitter facts) · languages/ · lsp/ · run (CodebaseMode entry)
  __init__.py  shared role constants (ROLES, ROLE_DESCRIPTIONS)
```

**The rule (enforced):** `diff/*` and `codebase/*` import only from `core/*` and within their own
folder — **never from each other**, and `core/*` imports neither. `eval/architecture_test.py` asserts
it (AST scan). This keeps the modes independently evolvable; adding a third mode is a new folder + a
`Mode`, no core surgery.

**The Mode strategy** (`core/mode.py`): each mode exposes `MODE` with `claims(args)` (do these CLI
flags belong to me?) and `run(args) -> int`. `decompose.py` is just argparse +
`dispatch([CODEBASE_MODE, DIFF_MODE], args)` — codebase claims `--graph/--scan/--expand-graph`, diff
is the `--file/--git/--from-classified` fallback. Each mode's pipeline lives in its folder's `run.py`.

The rest of this document details **diff-mode** (§1–§9), except **§8.5 (LLM call sites)** which maps
*both* modes. Codebase-mode shares `core/graph_ir` (the IR), `core/llm`, and `core/treesitter`, but
forks role assignment (anchor-relative BFS over a RESOLVED graph, not the `HunkFacts` ladder) — see
`decomposition-model-and-mvp.md`, `intent-expansion-plan.md`, and `resolver-lsp-plan.md`.

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
- **Distribution:** [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) — bun-from-source vs the
  `bun build --compile` single binary, the tree-sitter-grammar caveat, and the host-bus LLM seam.
- **MCP:** [`mcp/`](mcp/) exposes `decompose_diff` / `intent_footprint` to any agent. `det` is offline;
  `hybrid`/`llm` borrow the **caller's** model via MCP sampling, mapped onto the `--emit-prompts` →
  `--inject-llm` host-bus handshake (the same one the `seam-review` skill uses). **No daemon.**

---

## 1. Pipeline

```
                 ┌─────────────── deterministic shell ───────────────┐
  diff (file/git) → diff_source → parser → noise_filter ─────────────┐
                                  (Hunk[])   (marks noise)            │
                                                                      ▼
   ┌──────────────────── src/diff/engine.classify (orchestrator) ─────────────────┐
   │  facts = FactsProvider.facts(work)   # only if any pass is det/hybrid         │
   │                                                                               │
   │   ROLES pass   → roles/role_confidence            (det | llm | hybrid)        │
   │   WIRING pass  → seam/seam_label/wires  (reads roles)                         │
   │   CLUSTER pass → group/intent           (reads wiring for det)                │
   │   SPANS pass   → placements (overlap + header peel)   [always, deterministic] │
   └───────────────────────────────────────────────────────────────────────────────┘
                                                                      │
                                              hunks (fully labelled)  ▼
                       report_html.render → report.html        OR    seams.emit_seams_json → JSON
                       (cytoscape + diff2html)                    (consumed by the VS Code extension)
```

Stages (`decompose.py` is the CLI entry):

1. **`diff_source`** — load a unified diff from `--file` or `git diff <range>` (`--repo`); synthesizes diffs for untracked files.
2. **`parser`** (`unidiff`) — split into `Hunk`s with stable ids (`h1`, `h2`, …). **Python owns hunk-id assignment** — every other producer (incl. the VS Code extension) keys off these ids.
3. **`noise_filter`** — deterministic pre-pass marks whitespace / rename / binary / lockfile / doc / generated hunks as `noise` (the one role where determinism matters); they skip the classifier.
4. **`engine.classify`** — the per-pass classifier (§3).
5. **`assign_spans`** — deterministic overlap/header-peel (§5), always run.
6. **`seams`** (assembly) → **`report_html`** (HTML report), or **`seams.emit_seams_json`** for the extension.

---

## 2. Data model (`src/diff/parser.py`, `src/diff/facts.py`)

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

## 3. The per-pass classifier (`src/diff/engine.py`)

Three passes, each independently on one of three engines. **Order: roles → wiring → clusters → spans** (each reads the prior). `facts` is computed once if any pass is `det`/`hybrid`.

| pass | `det` | `llm` | `hybrid` | **default** |
|---|---|---|---|---|
| **cluster** (grouping) | connected components + structural label | LLM grouping + prose label | det grouping + LLM prose labels | **llm** |
| **roles** | structure + change-magnitude | LLM voting | det + LLM re-judges only the *uncertain* | **det** |
| **wiring** | subject anchoring + reconcile | LLM Pass C | **LLM-first**: LLM draws all + names seams, det grounds | **hybrid** |

**Engine choice rationale (measured, 4 shared gold cases):** roles det ≈ **0.77** vs llm ≈ 0.55; wiring det F1 ≈ **0.63** vs llm ≈ 0.24 (the llm number was role-confounded — see §9); cluster llm F1 ≈ **0.98** vs det ≈ 0.68. So: LLM where it's the only reliable engine (grouping), deterministic where it wins (roles), hybrid where the deterministic tail needs cleanup (wiring of tangled diffs).

Special case: **all-LLM** (`cluster=roles=wiring=llm`) routes to the legacy `classifier.classify` (cluster ∥ roles concurrently, then wire pass) for its speed optimization, then runs `assign_spans`.

`--classifier X` is a preset that sets all three; a per-pass flag overrides it. `--classifier det` = fully offline (no LLM).

### 3a. ROLES (`classifier_det.assign_roles` / `classifier.assign_roles`)

Deterministic ladder over `HunkFacts` (in order): `is_test` → `is_sql`→env → import-only / type-decl-only → env → `implements`→link (adapter) → then the **core/link** call from change-magnitude (`decisions`) + def↔use direction (defines-a-used-symbol = core; references-one = link). `role_confidence` is the heuristic's margin. `hybrid` re-judges only `< 0.6`-confidence hunks with the LLM. **Validated-safe rules only** (e.g. `implements`→link, `.sql`→env each co-occur with a single gold role); the `logic==0 ⇒ env` demotion was tried and reverted (it killed logic-less React cores).

### 3b. WIRING (`classifier_det` + `classifier.reconcile_llm`)

- **`det`**: subject-anchored wiring (`_subject_wiring`) — a non-core hunk wires to every core whose **distinctive subject** it mentions (a core's subject = its defs + the modified enclosing symbol + its call/JSX subjects). Distinctiveness drops ambient symbols (frequency cut) and **shared imported chrome** (symbols imported-from-outside the diff used in ≥3 hunks — `Button`, `useLocale`). Then `reconcile_wiring` (tier-2, deterministic): on an over-wired hunk (> 4 cores) keep only edges to cores it *owns* a symbol of; a hunk with **no owned edge is a legitimate hub** (header/barrel) → left alone.
- **`llm`**: `classifier.assign_wiring` (Pass C) — fragile standalone, kept for completeness.
- **`hybrid`** (default, **LLM-first**): the LLM **draws every non-core hunk's dependency line by meaning** *and* **names every seam** (technical intent) in one call, with the deterministic symbol candidates passed only as a **hint**. Then determinism **grounds** it: `h.wires = LLM_drawn ∪ det_owned` (re-add owned-symbol edges the LLM missed); no LLM list for a hunk → keep the deterministic candidates. This is the inversion: *LLM draws, determinism checks* — meaning over symbols, with symbol grounding as the safety net.

### 3c. CLUSTERS (`classifier_det.assign_clusters` / `classifier.assign_clusters`)

- **`det`**: connected components over the wiring graph; `intent` is a structural label (the cluster's core symbol via `_primary_symbol`, which prefers a Component/Type name over a destructured local).
- **`llm`** (default): LLM grouping + product-intent prose.
- **`hybrid`**: det grouping + LLM prose labels.

---

## 4. The Facts IR & producers (`src/diff/facts.py`, `src/diff/facts_treesitter.py`)

The deterministic passes contain **zero regex / language knowledge** — they read `HunkFacts`. A `FactsProvider` produces them; swap the provider to change the syntax source. Two producers are *correct iff they emit equal `HunkFacts`* — the contract that makes "tree-sitter ≡ VS Code AST" a test, not a hope.

- **`RegexFactsProvider`** — the generic fallback (regex over diff text; comments/strings masked for logic-side facts). Works degraded on any language.
- **`TreeSitterFactsProvider(file_source)`** — full-file AST (optional `tree_sitter_language_pack`); parses the post-image file, masks comment/string nodes, scopes to the hunk's changed lines, reuses `facts_for_hunk`. **Alignment-guarded** — if the working tree doesn't match the diff (wrong commit) it falls back to regex per hunk; never trusts a misaligned parse.
- **`ExternalFactsProvider(payload)`** — consumes a `HunkFacts` payload computed *outside* Python (the VS Code extension's language-server facts). Per-hunk regex fallback.
- **`MergedFactsProvider(base, payload)`** — overlays a *partial* external payload (only the fields a source can fill, e.g. VS Code DocumentSymbols → `defines`/`enclosing`) onto a base provider.
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

- **HTML report** (`report_html.render`) — self-contained (cytoscape graph + diff2html); seams built per cluster, spans/placements applied, per-seam *look-here* flags (isolated-core / dangling-link / uncertain / untested-core).
- **Seam JSON** (`seams.emit_seams_json`) — the contract for the extension: `{clusters:[{intent, seams:[{label, linkOnly, uncertain, warnings, hunks:[{id,file,start,end,role,confidence,external,externalRefs,rewire}]}]}], tests, noise}`.
- **VS Code extension** (`vscode-extension/`) — consumes `--emit-seams` and renders *natively*: per-seam role gutter bar (split where placements overlap) + scrollbar map + seam tree + CodeLens labels; lazy external-coupling resolution via the editor's go-to-definition (`VsCodeResolver`). It also *produces* facts: `facts.ts:computeSymbolFacts` walks DocumentSymbols → a partial `HunkFacts` payload, passed back via `--facts`. Setting **`seam.engine`** = `hybrid` (default → `--cluster llm --roles det --wiring hybrid`) | `det` (offline) | `llm`. *(The compiled `out/extension.js` must be rebuilt with `npm run compile` after TS edits.)*

---

## 7. CLI (`decompose.py`)

- Source: `--file` | `--git <range> --repo` | `--from-classified <json>` (re-render a dump, no LLM).
- Engines: `--cluster/--roles/--wiring {llm,det,hybrid}`, or `--classifier {llm,det,hybrid}` (preset).
- Facts: `--facts-engine {regex,treesitter}`, `--facts <json>` (external), `--emit-hunks <json>` (parse-only skeleton for an external producer).
- Output: `-o report.html` | `--emit-seams <json>`; `--dump-classified <json>` (the post-classify intermediate state, re-renderable).
- LLM: `--model`, `--claude-bin` (auto-detects `claude`, falls back to `copilot`).

---

## 8. Evaluation (`eval/`)

- **`harness.py`** — the regression gate. `generate --engine {det,llm}` runs each `cases/*.patch` (det once, llm N×, cached) → `score` computes **stability**, **accuracy** vs `gold/`, and **health**. Gates on N-run aggregates with tolerance. Wiring is scored by **seam-granular precision-weighted Fβ(0.5)** (a false coupling hurts a reader more than a missing one; seam-granular avoids the seam→core expansion artifact) — the old edge-recall **wiring F1 is kept for context but no longer gated**. Health's **over-wiring** (`over_wired` / max·mean seams-per-hunk) is the gated reading-failure signal; **isolated-cores / dangling-links / orphans are informational postures, NOT errors** (a dangling link may point at existing/external code, an isolated core may be a self-contained refactor) and are never gated. Optional `eval/sentinels/<case>.json` lists must-have couplings (e.g. the informal JNI edge a symbol scan can't see) as an under-wiring guard. Gold seam-granular = `eval/baseline-det.json`.
- **`extraction_test.py`** — exact assertions on the deterministic signals (external/rewire/alias/segmentation).
- **`facts_provider_test.py`** — the provider contract (round-trip, `external ≡ regex`, merge, fallback; the `assert_providers_equivalent` checker).
- **`treesitter_test.py`** — tree-sitter producer (comment/string masking win, clean-code equivalence, fallback, alignment guard).
- **`test_det_spans.py`** (pytest) — the spans/overlap + labelling unit suite.
- **`architecture_test.py`** — the loose-coupling guard (§0): an AST scan asserting `diff/*` and `codebase/*` never import each other and `core/*` imports neither. Fails if a cross-mode coupling creeps back.
- **codebase-mode** — `codebase_test.py` (anchor-relative roles → seams, end-to-end on a fixture graph), `resolver_test.py` (the Resolver strategy + real-LSP integration, `-m integration`), `import_scan_test.py`, `expand_test.py`, `orchestrate_test.py`, `anchor_rank_test.py`. Integration tests that spin up real language servers are marked `@pytest.mark.integration` and **excluded from the default run** (`pytest.ini`: `addopts = -m "not integration"`) — run them explicitly with `pytest eval/ -m integration`.
- **`gold/`** — hand-agreed labels (5 cases across C/C++/Kotlin+Ruby/TS+SQL). **`gold_candidates/`** — meaning-based candidates (LLM-first wiring dumps incl. cal.com) pending audit/promotion; the current wiring gold is symbol-derived and over-dense (acme-boosters 41 edges/24 hunks), so it under-scores meaning-based wiring (rework in progress).

---

## 8.5 LLM call sites (both modes) — the complete map

Every LLM call in the codebase funnels through `core/llm`: `resolve_backend()` (picks claude→copilot, or `("host","")` when a `HostBus` is installed) → `_run_pass()` (one pass, one retry, JSON-array parse) → `_run_backend()` → `_run_claude()` / `_run_copilot()` (the `subprocess.run` at `core/llm.py:~218`). Diff-mode passes call `_run_pass` directly (via `resolve_backend` per pass); codebase-mode passes call the thin `llm.run_pass(prompt, tag=…)` facade (`core/llm.py:349`) which wraps the same two. **One interception point covers everything** — installing a `HostBus` (`set_host_bus`) routes *all* of these through the running session / a subagent instead of a subprocess, in **both** modes, with no binary lookup (see `--emit-prompts`/`--inject-llm` and `.claude/skills/seam-review/`).

`thinking` is the per-call `MAX_THINKING_TOKENS` budget (0 = off/fast; a positive int caps it; ON is reserved for grouping). Every codebase-mode pass degrades to the deterministic floor on `LLMError`.

### DIFF mode (`src/diff/`)

Passes run in order **roles → wiring → clusters → spans** (`engine.classify`). Default engine = `cluster=llm roles=det wiring=hybrid` (what the VS Code extension sends).

| # | pass (function) | site | `tag` | thinking | in the **default**? |
|---|---|---|---|---|---|
| 1 | **wiring** reconcile — `classifier.reconcile_llm` | `classifier.py:715` | `reconcile` | 0 | ✅ **yes** (wiring=hybrid; only if ≥1 core) |
| 2 | **cluster** — `classifier.assign_clusters` | `classifier.py:557` | `cluster` | 2048 | ✅ **yes** (cluster=llm) |
| 3 | **roles** voting — `classifier.assign_roles` | `classifier.py:587` | `role` / `role.vN` | 0 | ❌ only if `roles=llm` (N-vote self-consistency) |
| 4 | **roles** reconcile — `classifier.reconcile_roles_llm` | `classifier.py:755` | `reconcile-roles` | 0 | ❌ only if `roles=hybrid` (re-judges `<0.6`-confidence) |
| 5 | **wiring** Pass C — `classifier.assign_wiring`→`_run_wire_pass` | `classifier.py:480` | `wire` | 0 | ❌ only if `wiring=llm` |
| 6 | **cluster** labels — `classifier.label_clusters_llm` | `classifier.py:791` | `label-clusters` | 2048 | ❌ only if `cluster=hybrid` |
| — | **all-LLM fast path** — `classifier.classify` (cluster ∥ roles, then wire) | `classifier.py:~848` | `cluster`,`role`,`wire` | mixed | ❌ only if `cluster=roles=wiring=llm` |

So the **default diff run makes exactly 2 LLM calls**: `reconcile` then `cluster`. `roles`/spans are deterministic.

### CODEBASE mode (`src/codebase/`)

CLI default = the **deterministic floor** (anchor → footprint → intent floor): `--classifier` is unset, so `use_llm=False` and the LLM is off. **The VS Code extension opts in** — its codebase scan sends the `seam.engine` setting (default `hybrid`) as `--classifier hybrid` (`extension.ts:644`), and codebase mode treats `hybrid`≡`llm` (`use_llm = args.classifier in ("llm","hybrid")`, no per-pass split), so a default extension scan **does** run `seam-refine` (and `relevance` too, but only when an `--intent` is given). All calls are `thinking=0` via `llm.run_pass`.

| pass (function) | site | `tag` | gated by | what it does |
|---|---|---|---|---|
| **seam refine** — `codebase.refine_seams_llm` | `codebase.py:364` | `seam-refine` | `use_llm` (`--classifier llm\|hybrid`) | F4: refines the deterministic floor into named technical-intent seams (a *proposed* partition over verified carriers; never invents an edge) |
| **mark relevance** — `codebase.mark_relevance_llm` | `codebase.py:432` | `relevance` | `use_llm` **and** `--intent` | F5: tags each link on-the-answer-path vs incidental relative to the question (additive — dims, never drops) |
| **residual discovery** — `llm_discovery.discover` | `llm_discovery.py:81` | `discover` | DOWN-expansion tier-3 path | proposes residual couplings the deterministic scan missed → SUGGESTED edges |
| **auto-orchestrate** — `orchestrate.auto_orchestrate` | `orchestrate.py:82` | `orchestrate` | `--auto` (needs `--symbol`+`--intent`) | P5 loop (≤ `--max-steps`): the LLM picks the next node + direction to grow the footprint toward the intent |

**The codebase invariant (`core/llm` docstring):** the LLM here only produces a *proposed partition / labels / suggestions* over **resolved** carriers — it never finds an atom or an edge (those are deterministically resolved), so a mis-frame can't make the map lie.

---

## 9. Key decisions & rationale (the load-bearing "why")

- **Deterministic-first, LLM on the residual.** Roles + wiring are deterministic (better, instant, reproducible); the LLM is spent only where it's the reliable engine (grouping) or where determinism's tail fails (over-wired containers).
- **Wiring's real bug was extraction, not roles.** Anchoring only on *newly-defined* symbols missed cores that *modify* existing ones; anchoring on a core's full **subject** lifted det wiring F1 0.13 → 0.63. Shared imported **chrome** (Button/useLocale) caused the cal.com hairball → dropped from anchors.
- **"LLM-first wiring is bad" was a measurement artifact** — the ~0.24 A/B ran LLM *roles* too (wiring is role-dominated) and the standalone Pass C was prompt-fragile. Given a good draw prompt the LLM wires fine, which is what makes the LLM-first hybrid sound.
- **Hubs vs containers.** A header/barrel with many *correct* edges looks "over-wired" by count; it's protected (no owned edge ⇒ not pruned/escalated). The inverted draw is hub-safe (LLM keeps real relations; det grounding re-adds owned edges).
- **Facts IR isolates language-specificity** to one swappable producer — the §10-honest path to tree-sitter / VS Code AST without touching the classifier.

### Known limits / open

- Vocabulary-saturation diffs (one feature, shared domain vocab) remain hard deterministically — the Layer-2/LLM case.
- Wiring **gold is being reworked** (symbol-derived, over-dense) so the LLM-first wiring can be measured honestly.
- VS Code AST producer is validated only on the Python contract; the extension TS needs F5 validation.
- **Codebase-mode** (non-diff: anchor → footprint) is **now built** (`src/codebase/`, §0) — no longer out of scope. It shares `core/` but forks role assignment; its language/stack resolution is externalised to real LSP servers (`codebase/lsp/`, `codebase/languages/`) — see `resolver-lsp-plan.md` and `intent-expansion-plan.md`.
