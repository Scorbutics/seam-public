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

The classification is the engine: a `--emit-seams` model (file + line range + role per hunk) that
the extension renders natively. The engine ships **inside** the `.vsix` (esbuild bundle), run with
VS Code's own Node — so installing the `.vsix` is all a user needs.

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

- **Claude Code** — the [Claude Code](https://www.anthropic.com/claude-code) VS Code extension (its
  bundled `claude` binary is detected automatically) **or** the `claude` CLI on your `PATH`
  (or `CLAUDE_BIN`). *Recommended — zero extra install if you already use Claude Code.*
- **GitHub Copilot CLI** — the standalone `copilot` binary on your `PATH` (or `COPILOT_BIN`). Note:
  the Copilot *VS Code extension* alone is not enough — it ships a completions language server, not a
  promptable CLI. (A no-install path via VS Code's Language Model API is planned.)

You must be signed in to whichever you choose; calls are metered against that subscription/plan.

Then set **`seam.engine`** (Settings → search "Seam") to `hybrid` (LLM intent + deterministic
roles/wiring — recommended) or `llm` (all passes by the LLM).

> **Offline fallback (`det`):** with no LLM backend, set `seam.engine` to `det` to still get a
> decomposition — but the seam labels are **structural**, not product-intent, so you lose the core of
> what Seam is for. Treat it as a degraded mode, not the default experience.

## Settings
- `seam.engine` — `hybrid` (LLM intent + deterministic roles/wiring — the intended experience; needs
  an LLM backend, see [above](#llm-required)), `llm` (all LLM), or `det` (offline structural fallback).
  Currently defaults to `det` so a fresh install always produces output; set `hybrid` once a backend is
  in place.
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
v1: role-coloured decorations (gutter + scrollbar) + seam tree + click-to-diff +
auto-saved/restored last run. The "gathered seam panel" (a side view stacking a
seam's hunks together) and commit-review (arbitrary refs) are the planned v2.
