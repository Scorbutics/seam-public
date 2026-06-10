# Architecture refactor — split diff-mode and codebase-mode behind a strategy

## Goal
Two products grew tangled in a flat `src/`: **diff-mode** (review working changes → seam report) and
**codebase-mode** (anchor → intent footprint → seams). Separate them into **loosely-coupled folders**,
each behind a **Mode strategy**, sitting on a small **shared core** — so the engine stays clean and
either mode can evolve (or be retired) without touching the other.

## Current state (what's tangled)
A flat `src/` mixes both pipelines. Three cross-mode couplings (codebase-mode reaching INTO diff-mode):
1. `import_scan` (codebase) imports `lang._IMPORT_RE` (diff's JS import regex).
2. `atoms` (codebase tree-sitter substrate) imports `facts_treesitter._LANG_BY_EXT/_parser/available`
   (the tree-sitter PARSING, which physically lives in a diff-mode file).
3. `llm` (used by codebase: `orchestrate`, `codebase`) RE-EXPORTS the claude-CLI plumbing from
   `classifier` (a diff-mode file) — its docstring even says "physical home can move here later".

Genuinely shared: `graph_ir` (the IR both fronts produce), the LLM/CLI plumbing, the tree-sitter
parsing, and the SeamModel JSON shape (two producers: `codebase.emit_seams` + `renderer.emit_seams_json`).

## Target structure
```
src/
  core/                      # mode-agnostic engine + substrate — NO mode imports it knows about
    graph_ir.py              # the shared IR (the §1.1 barebone; both fronts produce it)
    llm.py                   # claude-CLI plumbing — the REAL home (extracted from classifier.py)
    treesitter.py            # tree-sitter parsing substrate (extracted from facts_treesitter.py)
    seam_model.py            # the SeamModel JSON shape/helpers (the shared output contract) [optional]
    mode.py                  # the Mode strategy Protocol + the registry/dispatch
  diff/                      # diff-mode pipeline (review working changes)
    __init__.py              # DiffMode(Mode): parser → classifier → noise_filter → renderer
    parser.py  source.py(was diff_source)  syntax.py(was lang.py)  symbol_edges.py
    facts.py  facts_treesitter.py  classifier.py  classifier_det.py  engine.py
    noise_filter.py  renderer.py  templates/
  codebase/                  # codebase-mode pipeline (anchor → footprint → seams)
    __init__.py              # CodebaseMode(Mode): import_scan → decompose → SeamModel
    scan.py(was import_scan)  decompose.py(was codebase.py)  expand.py
    anchor_rank.py  orchestrate.py  resolver.py
    lsp/                     # (moves wholesale — already a clean package)
    languages/               # (moves wholesale — per-language providers)
```
`decompose.py` (repo root, the CLI) becomes a **thin dispatcher** over `core.mode`.

## The Mode strategy (the pattern Brice asked for)
```python
# core/mode.py
class Mode(Protocol):
    name: str                                   # "diff" | "codebase"
    def claims(self, args) -> bool: ...         # do these CLI args belong to this mode?
    def run(self, args) -> dict: ...            # produce the SeamModel (and/or write outputs)

def dispatch(args) -> dict:
    mode = next(m for m in MODES if m.claims(args))   # MODES = [DiffMode(), CodebaseMode()]
    return mode.run(args)
```
- `DiffMode.claims` = `--review` / `--commit` / `--from-classified`; `CodebaseMode.claims` =
  `--scan` / `--graph` / `--expand-graph`.
- Each mode OWNS its arg group, its pipeline wiring, and its output. The CLI just routes. Adding a
  third mode (or an MCP/extension entry) = a new `Mode`, no core surgery.
- Both `run()` return the SeamModel dict (the shared contract), so renderers/emitters stay uniform.

## The decoupling work (break the 3 cross-mode imports → a clean `core/`)
1. **LLM plumbing → `core/llm.py`.** Move `_run_pass`/`resolve_backend`/`ClassifierError` out of
   `classifier.py` into `core/llm.py` (its real home). Then `classifier` (diff) and `orchestrate`/
   `codebase` (codebase) both import from `core.llm`. (Today's `llm.py` re-export inverts to the truth.)
2. **Tree-sitter parsing → `core/treesitter.py`.** Move `_LANG_BY_EXT`/`_parser`/`available`/`lang_for`
   out of `facts_treesitter.py` into `core/treesitter.py`. Then `atoms` (codebase) and
   `facts`/`facts_treesitter` (diff) both import the parser from `core`; neither mode imports the other.
3. **JS import regex → `codebase/languages/typescript.py`.** Move `_IMPORT_RE` so it lives with the TS
   provider (where the other TS parsing now is). Diff's `syntax.py` keeps its OWN copy (the modes don't
   share a regex — loose coupling); codebase's `scan.py` imports it from its TS provider. This kills the
   last `codebase → diff` import.
After these, the dependency rule holds: **`diff/*` and `codebase/*` import only from `core/` and
themselves, never from each other.** A one-line CI/grep guard can enforce it.

## Phasing (each phase is mechanical moves + import rewrites, gated by the test suite)
- **P0 — stand up `core/`.** Create `core/`; move `graph_ir.py` in; do extraction #1 (llm) and #2
  (treesitter). Update imports repo-wide. `pytest eval/` green (112 fast tests). No behaviour change.
- **P1 — `diff/`.** Move the 11 diff modules + `templates/` into `diff/`; rewrite imports; keep public
  call sites working via `diff/__init__` re-exports if needed. Green.
- **P2 — `codebase/`.** Move the codebase modules + `lsp/` + `languages/` into `codebase/`; do extraction
  #3 (`_IMPORT_RE`). Green. (`pytest.ini` paths / the integration marker carry over.)
- **P3 — the Mode strategy.** Add `core/mode.py` + `DiffMode`/`CodebaseMode` (`__init__.py` of each
  folder); reduce root `decompose.py` to `dispatch(args)`. The extension's CLI calls are unchanged
  (same flags). Green + a manual F5 of both `seam.review` and a codebase scan.
- **P4 — enforce + tidy.** Add the "no `diff↔codebase` import" guard (a tiny test); update the
  extension's `toolPath` references if any module paths leaked; refresh the plan/README map.

Throughout: moves are `git mv` + `sed` import rewrites, verified by the **default gate (`pytest eval/`,
112 fast tests, <1s)** after every phase. Integration LSP tests stay opt-in.

## Risks & mitigations
- **Import churn** (many `from .X` → `from ..core.X` / `from .Y`). → one phase per layer, `sed`-driven,
  test-gated each step; the green gate is fast so iterate freely.
- **The CLI/extension contract** (`decompose.py` flags). → flags are unchanged; only internal wiring
  moves. P3 keeps the same argparse surface; F5 both modes.
- **Hidden shared state** (e.g. `_TS_ALIAS_CACHE`, `set_resolver`). → these live in modules that move
  wholesale (codebase/), so the state stays intact.
- **eval/ test imports** (`from src import import_scan`). → update to `from src.codebase import scan`
  etc. in the same phase; the suite is the safety net.

## Note on diff-mode's future (the open question from before)
This split is the RIGHT move regardless of that decision: if diff-mode stays, it's now a clean, self-
contained folder; if it's superseded by codebase-mode, a clean folder is trivial to deprecate/delete
(and the `core/` extractions — llm, treesitter, graph_ir — survive either way). So we don't need to
resolve "is diff-mode legacy?" first; separating it cleanly makes that decision cheap later.

## MVP cut
P0 (stand up `core/` + the two extractions) delivers most of the value — it breaks the cross-mode
coupling and gives a clean shared engine — with the least churn. P1–P2 (the folder moves) and P3 (the
strategy) can follow incrementally, each behind the green gate.
