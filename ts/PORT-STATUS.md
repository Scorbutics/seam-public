# TypeScript port — status

Branch: `port/typescript`. Deterministic-first, test-driven. Each module is driven against
the Python output as a **differential oracle** (`ts/test/oracle/`, regenerated from Python),
so "ported" here means *verified byte-identical to Python on real diffs*, not just "compiles."

Run: `cd ts && bun install && bun test` (161 pass / 2 gated-skip) · `bun run typecheck` (clean).
Real-LSP integration tests: `SEAM_LSP_IT=1 bun test test/resolver.test.ts`.

**STATUS: the port is complete and feature-1:1 with Python.** Diff mode (all engines, facts,
renderers, CLI, harness, blast-radius) and codebase mode (graph model, decompose, import_scan, LLM
passes, anchor_rank, expand, orchestrate, string_coupling, llm_discovery, headless LSP) are ported and
verified; the VS Code extension runs both natively via `seam.backend=ts`. The HTML report is
intentionally excluded (no longer used). The headless LSP (`--resolver lsp|auto`) is active in BOTH
modes, exactly as in Python — verified byte-identical on a real `typescript-language-server` across
det/lsp/auto (see the Headless LSP section).

## ✅ Done and verified (the whole deterministic classification pipeline)

| TS module | Ports | Verified against |
|---|---|---|
| `src/diff/parser.ts` | `parser.py` (+ a hand-written unified-diff parser, no `unidiff` dep) | parser oracle on 6 diffs (id/path/change_type/section/role) |
| `src/diff/noise_filter.ts` | `noise_filter.py` | same |
| `src/diff/lang.ts` | `lang.py` regex primitives | via facts + symbol_edges |
| `src/diff/facts.ts` | `facts.py` (HunkFacts IR, regex producer, all 3 providers, `new_side_lines`, `leading_ambient_lines`) | facts oracle byte-identical on 6 diffs + round-trip + external≡regex + merged override |
| `src/diff/symbol_edges.ts` | `symbol_edges.py` | `extraction_test` ported as spec — 14/14 (external coupling, A→B rewire, span-segment, alias) |
| `src/core/graph_ir.ts` | `connected_components` (rest of graph_ir pending) | via classifier |
| `src/diff/classifier_det.ts` | **`classifier_det.py` in full** (roles, subject-wiring, reconcile, clustering, multi-core `merge_seams`, span/overlap placements) | **classified oracle byte-identical on all 6 diffs**, field-by-field over every hunk |

**Bottom line:** `parse → noise → roles → wiring → reconcile → cluster → merge → spans`
produces the *exact same labeled hunks* as Python `--classifier det`, including the 54-hunk
cal.com diff (18 cores, multi-core seams, overlap placements).

### Two faithful-port bugs the oracle caught (documented so they don't recur)
- `"+- ".includes("")` is `true` in JS (empty string is a substring) → an empty diff line
  picked `undefined`. Python `raw[:1] in "+- "` doesn't have this. Fixed with `slice(0,1)`.
- Python `re` `\w` is **Unicode** by default (`Désactivé`, `Masqué` match whole); JS `\w` is
  ASCII. `_IDENT`/`_CALL_ROOT`/`_JSX_TAG` now use `\p{L}\p{N}_` under the `u` flag.

## ✅ Runnable + extension-wired (deterministic engine)

- `seams.ts` / `subgroup.ts` / `report_text.ts` / `engine.ts` / `diff_source.ts` / `cli/decompose.ts`
  ported. `emit_seams_json` + ascii/llm renderers verified byte-identical to Python on 6 cases +
  sample.patch, AND the CLI verified identical to `decompose.py --classifier det` on 5 real
  **git ranges** (`--emit-seams` and `--format ascii`).
- **Integration gap caught by end-to-end testing:** the CLI runs through `engine.classify`
  (which adds `merge_clusters_by_intent` after seam-merge), not the standalone
  `classifier_det.classify`. `engine.ts` replicates the det path exactly; oracles regenerated
  from `decompose.py` itself so the tests track real CLI behavior.
- **Extension wired:** `seam.backend` setting (`python` | `ts`). With `ts`, `Seam: Review working
  changes` spawns `bun ts/src/cli/decompose.ts --classifier det --emit-seams` instead of Python —
  same `--emit-seams` contract, native renderer unchanged. TS backend forces engine=det (LLM/hybrid
  still Python); no AST-facts/blast-radius yet (regex det is the verified path). Both projects tsc-clean.

## ✅ LLM engines — the default hybrid is ported & extension-wired

Verification method (since the model is stochastic): split each pass into **build-prompt →
model-call → parse/merge**; byte-verify the deterministic 90% against Python via the
`--emit-prompts`/`--inject-llm` **host-bus** contract. Same prompt in + same canned reply ⇒ same
output; only the (provider-shared) model call is nondeterministic.

- **`llm.ts`** (Phase 1) — backend resolution (host→claude→copilot, incl. `~/.vscode` ext glob),
  `_run_claude`/`_run_copilot` subprocess, `HostBus`, `extractJsonArray`, usage meter. *Gate:
  extractJsonArray vs Python on 8 tricky cases + HostBus contract.*
- **Cluster pass (Pass A)** (Phase 2) — `classifier_llm.ts`. *Gate: prompt byte-parity +
  inject-llm output parity, 7 cases each.*
- **Hybrid wiring** (Phase 3) — `reconcile_llm` + `build_reconcile_prompt` + det
  `apply_seam_groups`/`_overlap_subgroups` + `grounded_prune`; `engine.ts` `hybridWiring`. *Gate:
  reconcile prompt parity + full hybrid inject parity, 7 cases each.*
- **CLI + extension** — `--cluster/--roles/--wiring` + `--classifier` preset +
  `--emit-prompts/--inject-llm`; `seam.backend=ts` now runs the **default hybrid**
  (`cluster=llm, roles=det, wiring=hybrid` → the bundled claude serves the cluster + reconcile
  passes). *Gate: CLI emit-prompts + inject-seams identical to Python on sample.patch.*

Two more faithfulness fixes the strict prompt-parity forced (invisible to facts tests):
the parser now keeps the `\ No newline` marker and **bounds each hunk body by its `@@` line
counts** (like unidiff), and splits on **universal newlines** (CRLF). All re-verified against
the det git-range oracle.

**Only unverified-by-test bit:** the *real* `claude`/`copilot` subprocess call (structurally a
faithful port of Python's; the inject path proves everything around it). Like the det extension,
confirm with one live F5 run.

## ✅ Full LLM parity (Phase 4) — `--classifier llm` + `--classifier hybrid` done

The whole of `classifier.py` is ported. `classifier_llm.ts`: Pass B (`build_role_prompt`,
`_parse_spans`/`_sync_flat_from_spans`, `aggregate_role_votes` = the 5-vote medoid, `assign_roles`),
Pass C (`build_wire_prompt`, `run_wire_pass`, `assign_wiring`), `reconcile_wires`,
`merge_wiring_only_clusters`, the hybrid helpers (`reconcile_roles_llm`, `label_clusters_llm`), and
`classify_all_llm`. `engine.ts` runs the full **cluster × roles × wiring** matrix (det|llm|hybrid
each) + the all-LLM shortcut. **Gate:** role + wire prompt byte-parity; `--classifier llm` AND
`hybrid` inject-seams parity (7 cases each); `aggregate_role_votes` medoid vs Python on differing
votes; CLI emit-prompts byte-identical (cluster/role.v1-3/wire). **Live-confirmed:** real-model
runs of `--classifier llm` (5 calls) and the default hybrid (2 calls).

The extension's `seam.engine` (det | hybrid | llm) now runs entirely on the TS backend.

One deliberate difference: the role votes run **serially** here vs Python's concurrent threads, so
`--classifier llm` is ~5 sequential calls (the default hybrid is only 2, so unaffected). Making the
votes concurrent (async spawn instead of `spawnSync`) is a known perf-only follow-up.

## ✅ Phase 5 — facts providers (better deterministic roles)

- **5a — editor AST facts** (`MergedFactsProvider`): the CLI's `--facts` partial payloads (the
  editor's DocumentSymbol `defines`/`enclosing`) overlay the regex base. The extension now feeds
  these to the TS det/hybrid path via the TS `--emit-hunks` + `--facts` (same DocumentSymbols path
  as the Python backend; `--emit-hunks` byte-identical). *Gate: partial-facts CLI parity vs Python.*
- **5b — tree-sitter headless** (`facts_treesitter.ts` + `core/treesitter.ts`, `web-tree-sitter` +
  `tree-sitter-wasms`): full-file AST masking of comments/strings, an async pre-pass producing a
  facts payload the sync pipeline consumes. *Gate:* byte-identical to Python's
  `tree_sitter_language_pack` producer on shared DictFileSource fixtures (incl. the multi-line
  string-decoy masking WIN) **and** on a real working-tree git diff via `--facts-engine treesitter`.
  The UTF-16-vs-byte masking offset difference is harmless (masked spans only feed
  whitespace-insensitive regex checks). Pin: `web-tree-sitter@^0.25`.

## ✅ Phase 6 — the eval harness gates the TS binary

`eval/harness.py generate --ts-cli "<bun ts/src/cli/decompose.ts | dist/seam>"` drives the TS
binary as a black box (its `--dump-classified` output is scored against the same `eval/gold/`).
Verified: with both driven via their CLIs, the **TS-CLI reliability scorecard is byte-identical to
the Python-CLI scorecard across all 6 cases** (role accuracy, cluster F1, wiring Fβ, health), and
the regression gate passes. So the TS engine is regression-guarded by the same golds. (Note: the
harness's *native* `--engine det` uses the standalone `classifier_det.classify`, which differs from
the CLI engine path by `merge_clusters_by_intent` — always gate the TS port via `--ts-cli`.)

---

# ✅✅ Diff-mode port COMPLETE — the entire diff pipeline is on TypeScript, verified, and gated.

What's done: parser · noise filter · deterministic classifier · all three LLM engines
(det/hybrid/llm, cluster + role-voting + wiring) · seam assembly · ascii/llm renderers · CLI ·
both facts producers (editor AST + headless tree-sitter) · eval-harness gate. Every step is
byte-verified against Python (host-bus prompt/inject parity for LLM passes), live-confirmed with a
real model, and the extension runs all of it natively via `seam.backend=ts`.

## ✅ Blast-radius + deterministic resolver floor (diff-mode)

- `core/resolve/` floor ported: `languages/{base,typescript,python,index}` (TS/JS floor — relative
  paths, `package.json` name map, `tsconfig` `paths` aliases with `extends` + nearest-ancestor; named-
  import parser), `consumers` (the `set_resolver`/`_resolve`/`_resolve_import` seam), `resolver`
  (`DeterministicResolver` + `make_resolver`). `diff/{blast_radius,facts_resolve}`. CLI:
  `--blast-radius`, `--resolver`, `--facts-engine resolve`; extension passes `--blast-radius` on the
  TS backend. *Gate:* blast-radius consumers **identical to Python** on a committed fixture across all
  three resolution modes (relative / tsconfig alias / package name) with the same-named decoy
  excluded; `--facts-engine resolve` identical.

### ✅ Headless LSP (`--resolver lsp|auto`) — ported (C6)
The full LSP stack is ported under `core/resolve/lsp/`: `client` (generic JSON-RPC over stdio),
`pool` (one warm server per language+project-root), `resolver` (`LspResolver` go-to-def on the module
string + `DaemonResolver` persistent-daemon path), `daemon` (unix-socket daemon, idle TTL,
connect-or-spawn). `ServerSpec` + `bun_x`/`system` + `spec_for_file`/`language_id_for`/`project_root`
live in `languages/`; TS + Python carry LSP specs (minimal java/kotlin/ruby/c/cpp too).
`make_resolver lsp|auto` → `DaemonResolver`.

The async-client-vs-sync-`_resolve` clash was resolved by making the resolver seam **async
everywhere** — one `_resolve` / `_resolve_import` (async), `await`ed at exactly the call sites Python
calls them, in BOTH modes. The async cascade is contained: `facts → engine.classify → blast_radius /
seams / report → CLI` (the inner `det.assign_*` consume the already-built facts Map and stay sync).
Awaiting previously-sync values is identity-preserving, so the whole pipeline stays byte-identical
(the oracle suite is green through the cascade). *Gates:* 8 hermetic tests (always run) + 2 gated
integration tests (`SEAM_LSP_IT=1`) driving a real typescript-language-server (relative-import resolve
+ node_modules boundary; daemon warm-reuse cold-4s→warm-18ms); and a Python-vs-TS differential on
diff-mode `--blast-radius --resolver det|lsp|auto` — **byte-identical for all three** (the LSP gives a
different, more precise consumer set than the floor, and Python + TS agree on it exactly).

## ✅ Codebase mode — COMPLETE

- **C1** — `graph_ir` codebase model (`from_resolved_graph`, `wellformedness`, Node/Edge/Graph/Provenance). ✅
- **C2** — `codebase.ts` deterministic decomposition (roles, clusters, intent-seam floor, suggested
  seams, emit_seams + contracts). Byte-identical to Python on a scanned graph + a rich hand-authored
  graph (co-occurrence, crossings, blindspots, test node, containment). ✅
- **C3** — `atoms.ts` (web-tree-sitter substrate) + `detect_*` (subcores, contract+feeds, dynamic-
  import blindspots). `decompose` is async (awaits the tree-sitter passes when `--repo` is set).
  Byte-identical to Python on a TSX fixture repo exercising all four. ✅
- **C4** — `import_scan` front. ✅ single-symbol (`build_resolved_graph`), class anchor
  (`build_class_graph` + per-method attribution), module anchor (`build_module_graph` +
  co-occurrence), interface call-sites (`build_callsite_graph`), DOWN dependency graph
  (`build_dependency_graph`), depth-2 ripple (`_depth2_ripple`) — byte-identical to Python
  (`test/import_scan.test.ts`).
  *Note: the Python codebase decompose has set-order nondeterminism on complexity-tied carriers; the
  TS port is fully deterministic, so codebase decompose oracles are pinned with `PYTHONHASHSEED=0`.*
- **C5** — ✅ `anchor_rank`, `expand`, `orchestrate` (`--auto`), `string_coupling`, `llm_discovery`,
  LLM refine/relevance, and the `--emit-candidates` / `--attribution` CLI flows. Gated by host-bus
  prompt/inject parity + decompose oracles.
- **C6** — ✅ headless LSP resolver (`--resolver lsp|auto`), async seam (see above).
- ✅ Codebase CLI dispatch (`--scan`/`--graph`/`--expand-graph`/`--auto`/`--emit-graph`/`--emit-seams`)
  + the extension's codebase commands route through the active backend (`decomposeInvocation`).

## ✅ Previously-deferred items — now done (or intentionally out of scope)

- **`seams.ts` / `subgroup.ts` / `report_text.ts` / `cli/decompose.ts`** — all ported & verified
  (`ascii`/`llm` renderers, `emit_seams_json`, `--file/--git`, `--classifier det|hybrid|llm`,
  `--emit-seams`/`--emit-hunks`/`--dump-classified`/`--from-classified`). Runnable end-to-end.
- **LLM passes** (`classifier.py`, `engine.py` hybrid) — ported behind the host-bus seam (subprocess
  `claude` headless / in-extension `vscode.lm`); stochastic, so gated by **prompt+inject parity** (the
  deterministic envelope), not byte-match of the model output.
- **Codebase mode + `core/resolve/*`** — ported (incl. the headless LSP via the native Node LSP client,
  not `vscode-jsonrpc`); tree-sitter facts via `web-tree-sitter@^0.25`.
- **HTML report** — intentionally **excluded** (no longer used; the extension renders natively).
- **eval/harness** — kept as a black-box differential oracle (Python generates, TS asserts identical).

## Known parity caveats to sweep when convenient
- `_DEF_PATTERNS` name captures in `lang.ts` are still ASCII `[A-Za-z_]\w*` (the failing
  fixtures only exercised `_IDENT`/calls). A Unicode *definition* name would mismatch Python;
  Unicode-ify those captures when a fixture needs it.
- JS `\b` is ASCII-boundary even under `/u` (Python's is Unicode-aware). Only matters at a
  Unicode token boundary; current regexes anchor on ASCII keywords so it's not yet hit.

## How the oracles are regenerated (when Python changes)
See the inline `python - <<PY` snippets used to build `ts/test/oracle/*.{parsed,facts,classified,seams,ascii}.*`
in the port commits. Re-run them after any change to the Python deterministic passes, then `bun test`.
