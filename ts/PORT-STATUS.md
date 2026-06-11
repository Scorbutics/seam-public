# TypeScript port — status

Branch: `port/typescript`. Deterministic-first, test-driven. Each module is driven against
the Python output as a **differential oracle** (`ts/test/oracle/`, regenerated from Python),
so "ported" here means *verified byte-identical to Python on real diffs*, not just "compiles."

Run: `cd ts && bun install && bun test` (50 tests, all green) · `bun run typecheck` (clean).

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

## ⏭️ Next (ordered; oracles already captured in `ts/test/oracle/`)

### Remaining LLM parity (Phase 4) — for `--classifier llm` and `--classifier hybrid`
- **Pass B (seam+role)** — `_build_prompt` + `_parse_spans` + `assign_roles` with the **5-vote
  medoid** self-consistency (`_aggregate_role_votes`). Same host-bus gating.
- **Pass C (wiring)** — `_PROMPT_WIRE` + `_run_wire_pass` + `_reconcile_wires` +
  `_merge_wiring_only_clusters` (the all-LLM `classify` path).
- **hybrid roles/cluster** — `reconcile_roles_llm`, `label_clusters_llm`.
This unlocks `--classifier llm` and `--classifier hybrid` (all-three-hybrid) in the extension.

1. **`seams.ts`** ← `src/diff/seams.py` (531 lines): `_build_clusters`, `context_maps`,
   `_role_blocks`/`_span_map` (the block model the renderers consume), `_verify_pair`
   (well-formedness flags), `emit_seams_json`, `_merged_diff`, blast-radius wiring.
   Oracle: `*.seams.json` (6 cases + `sample`).
2. **`subgroup.ts`** ← `src/diff/subgroup.py` (140): `subgroup_seams` (altitude mid-level).
3. **`report_text.ts`** ← `src/diff/report_text.py` (241): `ascii` + `llm` renderers.
   Oracle: `*.ascii.txt` (6 cases + `sample`). This is the first **runnable** milestone —
   `seam --file sample.patch --classifier det --format ascii` should match the oracle.
4. **`cli/decompose.ts`** ← `decompose.py` + `src/diff/run.py` (diff branch, det path first):
   `--file/--git`, `--classifier det`, `--format ascii|llm`, `--emit-seams`, `--emit-hunks`,
   `--dump-classified`/`--from-classified`. Then diff vs Python on `sample.patch`.

## 🟡 Scaffolded later (need the interfaces, then validation — NOT a mechanical port)

- **LLM passes** (`classifier.py` 949 lines, `engine.py` hybrid): behind an `LlmBackend`
  interface (subprocess `claude`/`copilot` for headless; `vscode.lm` in-extension). The CODE
  ports; **behavioral equivalence is stochastic** → validate via the harness with tolerance,
  not byte-match. This is the part that needs your eyes.
- **Codebase mode** (`src/codebase/*`, `src/core/resolve/*`): LSP client → `vscode-jsonrpc`
  (headless) + the existing `resolver.ts` (in-editor). Tree-sitter facts → `web-tree-sitter`
  (spike confirmed: pin `web-tree-sitter@^0.25`; `tree-sitter-wasms` covers all 12 grammars).
- **HTML report** (`report_html.py` + jinja2): port the template; mechanical but tedious.
- **eval/harness.py**: keep in Python, drive the compiled `seam` binary as a black box
  (cheaper than re-porting 3.7k lines; keeps the existing golds as ground truth).

## Known parity caveats to sweep when convenient
- `_DEF_PATTERNS` name captures in `lang.ts` are still ASCII `[A-Za-z_]\w*` (the failing
  fixtures only exercised `_IDENT`/calls). A Unicode *definition* name would mismatch Python;
  Unicode-ify those captures when a fixture needs it.
- JS `\b` is ASCII-boundary even under `/u` (Python's is Unicode-aware). Only matters at a
  Unicode token boundary; current regexes anchor on ASCII keywords so it's not yet hit.

## How the oracles are regenerated (when Python changes)
See the inline `python - <<PY` snippets used to build `ts/test/oracle/*.{parsed,facts,classified,seams,ascii}.*`
in the port commits. Re-run them after any change to the Python deterministic passes, then `bun test`.
