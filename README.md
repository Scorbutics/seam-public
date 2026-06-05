# Seam

An MVP that takes a real diff and presents it **decomposed by role** —
**core / link / environment / test / noise** — so you can review *by intent* instead of
scrolling file-by-file.

It **structures, it does not judge.** No score, no approval, no "the LLM reviewed
it for you." It only pays the tax of manually reconstructing a change's structure
so the structured, triangulating review can happen without the linear scroll
fighting it. The human still trusts.

See `decomposition-model-and-mvp.md` for the full model. This tool exists to
answer **one** question (§9): *tool vs. discipline* — does the auto-decomposed
presentation deliver the value, or was the value the mental discipline?

## The five roles

| Role | What it is | Trust mechanism |
|---|---|---|
| **core** | The new/changed logic the change is about (incl. a *rule* — a guard/predicate/config that decides when/whether/which — however small) | Behavioral — does it work, is it complete |
| **link** | Joints wiring the new thing in (params across layers, call sites, adapters, type-routing) | Contract — do the integration points hold |
| **environment** | Ambient ripple (shared utils, globals, passive config/data, declarations) | Impact — what else does this affect |
| **test** | Code that *verifies* the change — it **covers** cores rather than being the change | Verification — CI runs it (skim), but is the coverage *real*? (delegated to no one) |
| **noise** | Renames, formatting, indentation | None — confirm it really is noise |

The boundary that matters: **"decides an outcome" → core** vs **"connects/routes" → link**.
See `decomposition-model-and-mvp.md` §2 + §12 for the reasoning (and why `test`
earned a role).

## How it works

A diff flows through a **deterministic shell**, an **LLM brain** in the middle, and
a **deterministic renderer**. The load-bearing split, measured: *grouping and roling
are LLM judgment; **wiring is grounding/tracing*** (which symbol defined here is
referenced there) — so wiring leans on deterministic symbol analysis, not free
reasoning. "Floor, not ceiling": the symbol layer is a high-precision floor the LLM
builds on; informal couplings stay the LLM's job.

### Pipeline

1. **diff_source** — load a unified diff from a file or `git diff <range>` (`--repo`).
2. **parser** (`unidiff`) — split into hunks with stable ids (`h1`, `h2`, …).
3. **noise_filter** — deterministic pre-pass marks whitespace/rename/binary noise
   (the one role where determinism matters; no LLM).
4. **classifier** — the LLM brain, via the local `claude` CLI (your Claude Code
   subscription; no API key). **Three passes** (A+B run concurrently, then C):
   - **Pass A — cluster (thinking ON):** group hunks into *functional clusters*
     carrying **product intent** ("what are we building"). Reasoning-heavy; the LLM
     does it holistically (cluster F1 ≈ 1.0).
   - **Pass B — role + span (thinking OFF, 3× medoid vote):** assign each hunk a
     role (core/link/environment/test/noise) and, where one hunk carries more than
     one role, per-line **spans**; name each seam's **technical intent**. *Grounded*:
     each hunk is shown deterministic symbol **candidate wirings** (def→use edges) so
     it confirms relationships instead of inventing them. Self-consistency voting
     stabilises borderline hunks; genuinely-split ones surface as *uncertain* (a
     per-hunk confidence), not flip-flopped.
   - **Pass C — wiring (thinking OFF, default; `WIRE_PASS=0` to disable):** a
     dedicated **core-first** pass run *after* roles are known, fed the summarised
     role output + the symbol-candidate floor. It wires each non-core hunk to the
     **core hunk-id(s)** it connects to. A *seam* = one core (its own id is the seam
     id) plus the links/env referencing that id — **many-to-many** (a link can wire
     several cores). Validated as the best wiring method; replaces the old
     `present[0]` reconciliation that produced a "junk-drawer" seam.
   It labels, it does not evaluate — clusters and seams are *proposals* the human's
   §3 self-check can violate.
5. **symbol_edges** — the deterministic grounding layer, shared by classifier and
   renderer:
   - `candidate_wirings` — symbol def→use edges (the Pass B/C floor).
   - `external_coupling` / `external_refs` — a hunk wiring code *outside* the diff
     (`import … from "@coss/ui"`): the §I "diff is not the codebase" boundary, made
     legible as `→ @coss/ui`, with the symbols to resolve.
   - `rewire_pairs` — the §I A→B rewire from a hunk's own `-`/`+` lines
     (`showToast → toastManager`).
   - `segment_link_by_core` + `resolve_alias` — locate, inside a big multi-core link,
     the line range wiring each core (§B span decomposition); a local wrapper alias
     is resolved by reading the file (the **FilesystemResolver**).
6. **renderer** — deterministic structuring:
   - **seam build** — per cluster, one core + the links/env that wire it, adjacent
     (so you read a core next to the links that wire it; the §3 self-check runs per
     seam). Two grains: **intent cluster** (coarse, "why") and **seam** (fine,
     "which wiring").
   - **span decomposition** — a big link/env wiring several cores is split so each
     **sub-range** shows only in the seam it wires (an import block → 3 per-core
     imports), not the whole block in every seam. A precisely-located span may
     **cross clusters** (a webhook render's `AppHeader` region → the app-header
     seam); a vague whole-hunk wire stays put.
   - emits **`emit_seams_json`** (the VS Code contract) or a self-contained **HTML
     report** (cytoscape + diff2html). Tests are a collapsed *skim* section (execution
     trusted to CI) with the cores they cover marked; noise its own section.

### The surface: VS Code extension (primary)

The extension consumes `--emit-seams` and renders **natively** — a per-seam
role-coloured **gutter bar** + **scrollbar map** and a **seam tree** (clusters →
seams → hunks), VS Code itself as the renderer (no HTML stack). It adds:
- **uncertain-role** markers (`core? uncertain 33%`) where the vote split;
- **external coupling** labels (`→ @coss/ui`) on hunks wiring outside the diff, with
  lazy **definition + signature** resolution on expand — the **VsCodeResolver**
  (borrows go-to-definition/hover; sibling of the Python FilesystemResolver);
- **rewire** markers (`↻ showToast → toastManager`);
- **span-aware** focus/nav: each occurrence is keyed by `id:start:end`, so focusing
  a seam lights up only *its* slice of a split hunk.

Per-seam **look-here flags** (never scores, just "verify this"): *⚠ isolated core*
(a core with no link in its seam), *dangling link*, *uncertain core* (vote split),
*⚠ untested core* (no `test` covers it). The tool still only structures; the human
judges.

### What gates each half

- **LLM passes** (roles, clusters, wiring) → `eval/harness.py`: N-run **stability**
  (no gold) + **accuracy** (role / cluster-F1 / wiring-F1 vs labelled gold). Noisy,
  so it gates on aggregates with tolerance.
- **Deterministic signals** (`external`, `rewire`, span segmentation, alias
  resolution) → `eval/extraction_test.py`: **exact** assertions on hand-labeled
  real hunks (the right tool — these are pure functions of the diff).

## Install

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

You need a subscription-backed LLM CLI (no API key). The classifier prefers the
Claude Code `claude` CLI (auto-detected from PATH, `$CLAUDE_BIN`, or the VSCode
extension; override with `--claude-bin`). If `claude` is not found, it **falls
back to the GitHub `copilot` CLI** (auto-detected from PATH or `$COPILOT_BIN`),
using your Copilot subscription model — set `$COPILOT_MODEL` to pick a specific
one. Order: `--claude-bin` → `claude` → `copilot`.

## Usage

```bash
# from a patch file
python decompose.py --file change.patch --open

# from a git range in a repo
python decompose.py --git main..HEAD --repo /path/to/repo --open
```

Options: `--out report.html`, `--model claude-haiku-4-5`, `--claude-bin PATH`,
`-v/--verbose`, `--debug`.

### Re-rendering without the LLM (intermediate state)

The classify pass (the only LLM step) dumps to a JSON of fully-labeled hunks —
the *intermediate state* between classification and rendering. Save it once, then
iterate on the renderer/template against a fixed, real example with no LLM cost:

```bash
# classify once and keep the intermediate state
python decompose.py --file sample.patch --dump-classified samples/sample.classified.json

# re-render straight from it — no diff parsing, no classifier
python decompose.py --from-classified samples/sample.classified.json --open
```

A ready-made example is checked in at `samples/sample.classified.json` (from
`sample.patch`); it includes a shared link wiring two cores, so the many-to-many
seam view is visible out of the box.

### Debugging the AI output

`-v/--verbose` shows the plumbing (which backend, token estimate, retries).
`--debug` shows what the model actually produced:

- the **raw model reply** (before parsing) printed to stderr — this is what to
  read when a hunk is mis-classified or the JSON fails to parse;
- backend diagnostics — for `claude`, the model(s) used, input/output tokens,
  duration, and cost from its JSON envelope; for `copilot`, the exact command,
  exit code, and its stderr;
- the full prompt and reply dumped to `<out>.prompt.txt` / `<out>.reply.txt`.

```bash
python decompose.py --file change.patch --debug 2>debug.log
```

Note: in `-p` (headless) mode neither CLI exposes its chain-of-thought — the JSON
envelope / stdout carries only the final answer. The reply is the artifact to
inspect; each CLI's own progress logs (if any) show up on its stderr, which
`--debug` prints.

### Speed & cost

Roughly **~90s / diff** = 1 cluster pass (thinking ON — the slow part) + 5 role
votes (thinking OFF, ~10s each) + deterministic post-processing. `claude -p`
defaults thinking ON, which on a labeling task burns ~15–22K output tokens
(~160s) for a ~550-token answer — so the role pass forces `MAX_THINKING_TOKENS=0`
(~16× faster, equal/better roles). The cluster pass keeps thinking (grouping
needs it). Tune votes via `ROLE_VOTES` and the cluster budget via
`CLUSTER_THINKING` in `src/classifier.py`. This is batch review tooling — you run
it once and read the report — so ~90s is fine.

## Running the experiment (the actual point — §10)

This is a pre-registered experiment, not a product. Before you open the report:

1. Pick a real, tangled change (legacy or AI-authored). Small clean PRs don't need
   this — the linear process already handles them.
2. **Write your prediction first** (time, trust 0–10) — for both a normal linear
   review and a by-role review. Writing it before looking is the lie detector.
3. Review once linearly, once by role (with a real break between). Record actual
   time + trust + any "why is this linked *here*?" self-check moments.
4. The question to answer: is reviewing-by-role-without-scrolling **dramatically**
   better than the manual decomposition that already beats linear review? Dramatic
   → the tool is the product. Marginal → the value was the discipline, and the
   deliverable is a written method, not software.

## Reliability harness (`eval/`)

The classifier is an LLM and **not deterministic** (the CLI exposes no
temperature). `eval/harness.py` makes reliability measurable so a prompt/model
change can't silently make it worse:

```bash
python eval/harness.py generate --runs 5   # run each eval/cases/*.patch N times (cached)
python eval/harness.py score                # stability (no gold) + accuracy (vs eval/gold/)
python eval/harness.py score --save eval/baseline-haiku.json
python eval/harness.py score --baseline eval/baseline-haiku.json   # gate: non-zero on regression
```

It separates **stability** (run-to-run agreement) from **accuracy** (vs
hand-labeled gold: role accuracy, permutation-invariant **cluster F1** *and*
**wiring F1**) and reports **health** (seam count, spurious warnings, orphans) —
the goal is "an acceptable representation," not per-hunk label-match. Read wiring F1
*alongside* role accuracy: it's role-dominated. Cases are seeded from 4 real diffs
across C / C++ / Kotlin+Ruby / TS+SQL.

The **deterministic** signals (external coupling, A→B rewire, span segmentation,
alias resolution) are *pure functions of the diff*, so the stochastic harness is the
wrong tool — they're gated by **`eval/extraction_test.py`** with exact assertions on
hand-labeled real hunks.

## Known MVP limitations

- **Three model passes**, no chunking yet: large diffs may exceed context. The
  classifier estimates tokens (~3.5 chars/token) and **warns** near the usable
  window (`--context-window`, default 200k). The cluster pass (thinking ON) is the
  wall-clock floor; the role votes and the wiring pass run cheap (thinking OFF).
- **Wiring is role-dominated.** Seam wiring quality is capped by role accuracy (a
  mis-roled core breaks its seam's edges) — and role accuracy on the core/link
  frontier tops out around ~0.8 (genuinely blurry). The interface compensates by
  **surfacing uncertainty** rather than pretending to perfection (the *uncertain*
  markers), and Pass C wiring is high-precision (what it draws is right).
- **Span splitting needs literal symbols.** A big link splits per-core only where it
  uses each core's symbol *by name*; an **informal/aliased** coupling (a local
  wrapper, or a Pass-C wire made on intent rather than code) can't be located and
  stays whole. The FilesystemResolver / VsCodeResolver resolve *genuine* wrappers
  (read the file / go-to-definition) but won't fabricate a link that isn't in code.
- **Cross-boundary couplings need the resolver.** A change that wires the system it
  *targets* (a migration to `@coss/ui`) couples to code outside the diff (§I); the
  tool labels the boundary (`→ @coss/ui`) and resolves the target on demand, but
  full codebase-awareness is a flagged direction, not a build commitment.
- The **external-person test** (Q3, the gate to "product for others") is still
  unrun — all evidence is self-generated.
- No GitHub PR ingestion, no persistence, no line-level roles.
