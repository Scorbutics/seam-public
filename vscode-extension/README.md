# Seam — review by intent (VS Code extension)

> **Experimental.** Distributed as a `.vsix` (GitHub Releases), **not** on the Marketplace yet.

Seam decomposes a diff (or a slice of a codebase) into **seams** — groups of changes that share one
technical intent — and paints them natively in VS Code so you review one intent at a time. The
TypeScript engine is **bundled inside the extension** (no separate checkout, no `bun`). The
intent-driven decomposition is **LLM-powered** — it runs through your existing **Claude Code** or the
**GitHub Copilot CLI** (see [LLM — required](#llm-required)). VS Code is the renderer:

- **Seam colours on the diff** — per changed hunk, coloured by **role**
  (core=amber · link=blue · environment=gray · test=green · noise=faint): a gutter
  bar, a scrollbar overview mark, and a very light line-background wash.
- **Intent · seam label on top of each hunk** — a CodeLens header
  (`◆ <seam label> · <cluster intent>`); click it to focus that seam.
- **Seam tree** (activity-bar icon) — clusters → seams → hunks. Click a hunk to
  jump the editor to it (the "related code closer" navigation).

A seam is an **intent at a sub level** — and you *see* it: the colours, the tree, and the scrollbar
map turn "what is this change actually doing" into something you read at a glance, instead of holding
it in your head while scrolling. That visual decomposition of intent is the point.

The classification is the engine: a `--emit-seams` model (file + line range + role per hunk) that
the extension renders natively. The engine ships **inside** the `.vsix` (esbuild bundle), run with
VS Code's own Node — so installing the `.vsix` is all a user needs.

## Codebase mode (map an intent)

Beyond diffs, Seam maps where an intent **lives across a repo**. From the editor: **Analyze codebase
from anchor** (cursor), **Analyze module** (a file's exports), **Find footprint by intent…** (describe
it in words), or **Auto-map intent** (grow the footprint toward a question). Seam traces the footprint
and renders it as seams — an **anchor → spine → culmination** path, off-domain parts dimmed, and edges
it can't statically resolve flagged as `SUGGESTED` / blindspots rather than asserted. Use it to
understand how a feature flows, or to map a change's blast radius before you make it. No index to build
or keep fresh — it traces on demand, in any supported language.

## Install (try it)
1. Download `seam-<version>.vsix` from the [Releases](https://github.com/Scorbutics/seam/releases) page.
2. Install it:
   ```bash
   code --install-extension seam-<version>.vsix
   ```
   …or in VS Code: **Extensions** panel → **⋯** menu → **Install from VSIX…**
3. Reload. Open any git repo, click the **Seam** icon in the activity bar → **Review working changes**
   (or `Cmd/Ctrl+Shift+P` → *Seam: Review working changes*).

No `bun` and no checkout needed — but you do need an LLM backend (next).

## LLM (required)
Seam's value is **intent-driven** decomposition: grouping changes by what they're trying to do and
labelling each seam with that intent. That reasoning is done by an LLM, so an LLM backend is
**required** for the real experience. Seam does **not** ship a model or take an API key — it borrows a
CLI you already have. Provide **one** of:

- **GitHub Copilot via VS Code** *(no install)* — set **`seam.llmBackend`** to `copilot` and Seam
  borrows a chat model through VS Code's Language Model API (the same models Copilot Chat uses). No CLI,
  no API key; VS Code asks once for consent. Picks the largest-context model available. *Easiest if you
  already have Copilot.*
- **Claude Code** *(`seam.llmBackend: cli`, the default)* — the
  [Claude Code](https://www.anthropic.com/claude-code) VS Code extension (its bundled `claude` binary is
  detected automatically) **or** the `claude` CLI on your `PATH` (or `CLAUDE_BIN`). Largest context
  (≈200K), so best for very big diffs.
- **GitHub Copilot CLI** *(`seam.llmBackend: cli`)* — the standalone `copilot` binary on your `PATH`
  (or `COPILOT_BIN`). Note: the Copilot *VS Code extension* alone only satisfies the `copilot` backend
  above, not this — as a CLI it ships a completions language server, not a promptable CLI.

You must be signed in to whichever you choose; calls are metered against that subscription/plan.

Then set **`seam.engine`** (Settings → search "Seam") to `hybrid` (LLM intent + deterministic
roles/wiring — recommended) or `llm` (all passes by the LLM).

> **Big diffs on the `copilot` backend:** VS Code models have a per-request input cap (gpt-4o ≈ 64K
> tokens; a ~280 KB diff is the practical ceiling). Seam picks the largest-context model and pre-checks
> each pass; if a change still doesn't fit it tells you to narrow the range or switch to `cli` (Claude
> Code's ≈200K window). The `cli` backend has far more headroom.

The `copilot` backend also serves **codebase mode** (Analyze from anchor/module/class, Expand). Two
operations stay on the `cli` backend because their LLM work happens across multiple steps that VS Code's
model can't serve in one pass: **Auto-map intent** (it tells you to switch to `cli`) and the dependency
discovery in **Expand → dependencies** (Expand → consumers is fine).

> **Offline fallback (`det`):** with no LLM backend, set `seam.engine` to `det` to still get a
> decomposition — but the seam labels are **structural**, not product-intent, so you lose the core of
> what Seam is for. Treat it as a degraded mode, not the default experience.

## Settings
- `seam.engine` — `hybrid` (LLM intent + deterministic roles/wiring — **the default** and intended
  experience; needs an LLM backend, see [above](#llm-required)), `llm` (all LLM), or `det` (offline
  structural fallback — no backend needed, but seam labels are structural, not product-intent). With no
  LLM backend available, set `det` so a fresh install still produces output.
- `seam.resolver` — `det` (default, offline). `lsp`/`auto` need a dev checkout (see below).
- `seam.blastRadius` — on by default.
- `seam.toolPath` — **dev only**: point at a `code-review-sort` checkout to run the engine from
  source under `bun` instead of the bundle (enables the `lsp`/`auto` resolver and the F5 workflow).

## Build / develop
```bash
cd vscode-extension
bun install
bun run build      # tsc (extension) + esbuild (engine → out/engine/*.cjs) + copy WASM grammars
bun run package    # → seam-<version>.vsix
```
Dev loop: **F5** (Run → Start Debugging) launches an Extension Development Host. With `seam.toolPath`
set to your checkout, the engine runs from source under `bun` (no rebuild of the bundle needed).

## Focus a seam (the point of the tool)
**Select a seam in the tree → only that seam's hunks stay coloured; every other
seam disappears from the editor**, so you review one intent in isolation. Selecting
a *cluster* focuses all its seams; selecting a *hunk* focuses its seam (and opens
the diff). To see everything again, press the **eye** button (*Show all seams*) in
the view title. The banner shows what you're focused on.

## Persistence
The last run is **saved per workspace** and **restored automatically** when you
reopen the folder — no re-running the LLM on the same diff. The tree shows a
`last run: <range> · <time>` banner so you know it's cached; re-run any time to
refresh, or `Seam: Clear decorations` to forget it.

## Status
Shipped: diff review (role-coloured gutter + scrollbar decorations, seam tree, click-to-diff,
auto-saved/restored last run) **and** codebase mode (intent footprints from an anchor / module /
natural-language intent, auto-grow, expand consumers & dependencies). Planned: a "gathered seam panel"
(a side view stacking a seam's hunks together) and commit-review across arbitrary refs.
