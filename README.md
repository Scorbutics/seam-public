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

1. **diff_source** — load a unified diff from a file or `git diff <range>`.
2. **parser** — `unidiff` splits it into hunks with stable ids (`h1`, `h2`, …).
3. **noise_filter** — deterministic pre-pass marks whitespace/rename/binary noise
   (no LLM needed for the one role where determinism matters).
4. **classifier** — via the local `claude` CLI (your Claude Code subscription — no
   API key). **Two passes**, because grouping and roling have opposite needs
   (measured — see the design doc §12):
   - **Pass A — cluster (thinking ON):** group hunks into *intent clusters*
     (grammar-driven: a link goes with the core it wires in). Grouping is
     reasoning-heavy; the LLM does it holistically well.
   - **Pass B — seam + role (thinking OFF):** assign each hunk a role
     (core/link/environment/test/noise), its seam, and its wiring — local
     pattern-matching, more accurate *and* ~16× faster without thinking. Run **5×
     with a medoid vote** (self-consistency) so the output is stable run-to-run;
     genuinely 50/50 hunks are surfaced as *uncertain* rather than flip-flopping.
   - A deterministic step then reconciles noisy wires (drops the spurious
     dangling-link warnings). It labels, it does not evaluate; the cluster and
     seams are *proposals* the human's self-check can violate.
5. **renderer** — primary axis is the **intent cluster** (§3 triangulation),
   drawn as a **cluster graph**: each intent is a box, the seams inside it are
   nodes, and edges connect them — a **solid wiring edge** (one link wiring more
   than one core: the shared joint) and a **dashed file edge** (seams in
   *different* clusters touching the same file). **Click a seam** to read its core
   next to the links that wire it in; **click an edge** to open the two connected
   seams side by side. A core-less cluster (a legitimate link-only *rewire*) is
   shown as one seam with a neutral "verify the connection" posture, not a false
   warning. Tests are pulled into a collapsed *tests* section (skim — execution is trusted
   to CI), with the cores they cover marked; noise into its own collapsed section.
   Self-contained responsive HTML (cytoscape + diff2html via CDN).

   Two grouping levels make core↔link triangulation tight:
   - **Intent cluster** (coarse, "why") — the sub-change's purpose.
   - **Seam** (fine, "which wiring") — one core and the *specific* link(s) that
     wire it, shown adjacent so you read a core right next to its link. The
     core↔link relation is **many-to-many**: a single link can wire several cores
     (a shared call-site), so it appears in every seam it wires rather than being
     forced into one. Seams are labeled blocks within a cluster; the §3 self-check
     ("is this link where this core led you to expect it?") runs per seam.

   The report is **intent-first**: you scan the cluster boxes and the seam nodes
   inside them, follow the wiring edges (shared links) and the cross-cluster
   file edges (entangled intents), then click only the seams that look risky.
   Per-seam **look-here flags** (never scores, just "verify this"): *⚠ isolated
   core* (a core with no link in its seam); *dangling link* (a link with no core);
   *uncertain core* (self-consistency voting was split — the classifier wasn't
   sure this is a real seam); and *⚠ untested core* (no `test` covers it — the
   coverage signal nobody else checks). The tool still only structures.

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
hand-labeled gold, with a permutation-invariant clustering F1) and reports
**health** (seam count, spurious warnings, orphans) — because the goal is "the
report reads as an acceptable representation," not per-hunk label-match. Cases are
seeded from 4 real diffs across C / C++ / Kotlin+Ruby / TS+SQL.

## Known MVP limitations

- **Sub-hunk fusion** is handled by **spans** (a hunk can carry >1 role — e.g.
  imports=environment + a new rule=core), but a hunk still lands in **one
  cluster**.
- **Two model passes**, no chunking yet: large diffs may exceed context. The
  classifier estimates tokens (~3.5 chars/token) and **warns** near the usable
  window (`--context-window`, default 200k).
- **`routing→link` is probably too broad** — a guard that *adds behavior while
  integrating* is really a core (see litergss3); a careful prompt refinement is
  pending.
- **Cross-seam def→use threads are not drawn** — a core defined in one seam and
  used in another isn't linked in the graph. The textual shared-identifier
  heuristic that attempted this was removed (too noisy: it can't tell a call from
  a shared variable/type without per-language parsing); that navigation is
  deferred to the editor's own go-to-definition.
- The **tool-vs-discipline** question (the actual point, §8.2) is still
  unanswered — the tool is built but the external-person protocol hasn't been run.
- No GitHub PR ingestion, no persistence, no line-level roles.
