# Seam

An MVP that takes a real diff and presents it **decomposed by role** —
**core / link / environment / noise** — so you can review *by intent* instead of
scrolling file-by-file.

It **structures, it does not judge.** No score, no approval, no "the LLM reviewed
it for you." It only pays the tax of manually reconstructing a change's structure
so the structured, triangulating review can happen without the linear scroll
fighting it. The human still trusts.

See `decomposition-model-and-mvp.md` for the full model. This tool exists to
answer **one** question (§9): *tool vs. discipline* — does the auto-decomposed
presentation deliver the value, or was the value the mental discipline?

## The four roles

| Role | What it is | Trust mechanism |
|---|---|---|
| **core** | The new/changed logic the change is about | Behavioral — does it work, is it complete |
| **link** | Joints wiring the new thing in (params across layers, call sites) | Contract — do the integration points hold |
| **environment** | Ambient ripple (shared utils, global CSS/config) | Impact — what else does this affect |
| **noise** | Renames, formatting, indentation | None — confirm it really is noise |

## How it works

1. **diff_source** — load a unified diff from a file or `git diff <range>`.
2. **parser** — `unidiff` splits it into hunks with stable ids (`h1`, `h2`, …).
3. **noise_filter** — deterministic pre-pass marks whitespace/rename/binary noise
   (no LLM needed for the one role where determinism matters).
4. **classifier** — ONE pass over the whole remaining diff via the local `claude`
   CLI (your Claude Code subscription — no API key). It does two things at once,
   using full-diff context: (a) **groups** hunks into *intent clusters* (coherent
   sub-changes — grammar-driven: a link goes with the core it wires in), and
   (b) **roles** each hunk (core/link/environment/noise). It labels, it does not
   evaluate; the cluster is a *proposal* the human's self-check can violate.
5. **renderer** — primary axis is the **intent cluster** (§3 triangulation): each
   cluster shows its core next to the links that wire it in, so "links tell you
   where to expect cores". Within a cluster, hunks are shown per role and merged
   per file. Noise is pulled into one global collapsed section. Self-contained
   responsive HTML (diff2html via CDN).

   Two grouping levels make core↔link triangulation tight:
   - **Intent cluster** (coarse, "why") — the sub-change's purpose.
   - **Seam** (fine, "which wiring") — one core and the *specific* link(s) that
     wire it, shown adjacent so you read a core right next to its link. Seams are
     labeled blocks within a cluster; the §3 self-check ("is this link where this
     core led you to expect it?") runs per seam.

   The report is **intent-first drill-down**: clusters are collapsed by default,
   so you scan the intent headings, role pills, and any warnings, then expand only
   what looks risky. The **triangulation check** runs per seam: a core with no
   link in its seam is flagged *⚠ isolated core*; a link with no core is a
   *dangling link*; an ambient-only seam is *delegated* (data/config). Seam-level
   warnings roll up to a badge on the collapsed cluster so risk stays visible. The
   tool still only structures — these are flags to look at, never a score.

   **Wiring connectors (the bipartite graph).** A seam is a linear partition, but
   a link can wire cores that live in *different* seams or clusters. The classifier
   emits, per link, the core hunk id(s) it `wires`; the renderer surfaces the edges
   seaming could not keep adjacent as navigable connectors: *↗ wires* / *↙ wired by*
   chips (blue = **cross-seam**, purple = **cross-cluster** — the meta-link signal).
   Hover highlights both endpoints; click expands and scrolls to the target. A
   cross-seam connector often *explains* an isolated-core flag ("its link is in
   seam s1"). The summary bar shows **cross-seam / cross-cluster counts** — a tangle
   metric: if they're ~0 on real diffs, seams alone suffice and the graph adds
   nothing; if they're high, it's surfacing structure the linear view hid.

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

## Known MVP limitations

- **Hunk-level granularity:** a single hunk can mix core + link, or even straddle
  two intents — and it can only land in one cluster. (Seen on the sample: a
  `payment.py` hunk carrying *both* currency and discount changes lands in one
  cluster, leaving the other cluster's view thinner than the real change.) We
  don't split below the hunk yet; this is the next thing to fix if clustering
  proves valuable.
- **One model pass:** large diffs may exceed context. The classifier estimates
  token count from diff size (~3.5 chars/token) and **warns** when it nears the
  usable window (`--context-window`, default 200k); it does not yet chunk.
- No GitHub PR ingestion, no persistence, no line-level roles. Add only if the
  tool-vs-discipline question returns positive.
