# Seam — VS Code extension (thin)

A thin shell over the Seam engine (TypeScript, run via bun). It does **not** render anything itself —
VS Code is the renderer:

- **Seam colours on the diff** — per changed hunk, coloured by **role**
  (core=amber · link=blue · environment=gray · test=green · noise=faint): a gutter
  bar, a scrollbar overview mark, and a very light line-background wash.
- **Intent · seam label on top of each hunk** — a CodeLens header
  (`◆ <seam label> · <cluster intent>`); click it to focus that seam.
- **Seam tree** (activity-bar icon) — clusters → seams → hunks. Click a hunk to
  jump the editor to it (the "related code closer" navigation).

The classification is the engine: this consumes the TS CLI `--emit-seams`
(file + line range + role per hunk).

## Prerequisites
- **bun** (the engine runs via bun; the extension itself runs in VS Code's Node):
  `curl -fsSL https://bun.sh/install | bash`
- **VS Code**.
- The Seam **engine** — i.e. the `ts/` TypeScript engine in your `code-review-sort`
  checkout (this extension shells out to `ts/src/cli/decompose.ts` via bun; no Python).

## Build
```bash
cd vscode-extension
bun install
bun run compile          # tsc -p ./ → out/extension.js   (bun run watch to auto-rebuild)
```

## Run it — two ways

### A) Dev mode (F5) — use this while iterating on the look
1. In VS Code: **File → Open Folder…** → select this `vscode-extension` folder.
2. Press **F5** (Run → Start Debugging). A `.vscode/launch.json` is included, so this
   compiles and launches a second window — the **Extension Development Host** — with
   Seam loaded. (If the pre-launch compile fails, run `bun run compile` once manually.)
3. In that second window: **File → Open Folder…** → the repo you want to review.
4. Click the **Seam** icon in the activity bar (left rail) → press the
   **Review working changes** title button — or `Cmd/Ctrl+Shift+P` →
   *Seam: Review working changes* (or *Seam: Review a commit…*).
5. The tree fills with clusters → seams → hunks. Open a changed file (or its SCM
   diff) to see the gutter bars + scrollbar marks; click a hunk in the tree to jump.

In dev mode `seam.toolPath` **auto-resolves** to this checkout, so no config needed.

### B) Install permanently (.vsix) — once the look is right
```bash
bun run compile
bunx @vscode/vsce package --no-dependencies      # → seam-0.0.1.vsix
code --install-extension seam-0.0.1.vsix          # or: Extensions panel → "…" → Install from VSIX…
```
Then reload VS Code; the **Seam** icon appears in every window.

> **Important for the installed (.vsix) path:** the extension now lives under
> `~/.vscode/extensions/…`, so it can't find the `ts/` engine by itself. **Set
> `seam.toolPath`** (Settings → search "Seam") to your `code-review-sort` checkout.
> (Not needed in dev/F5 mode.)

## Settings
- `seam.toolPath` — path to the `code-review-sort` checkout (auto in F5; **required** for .vsix).
- `seam.engine` — `hybrid` (default), `det` (offline), or `llm`.
- `seam.resolver` — `auto` (default), `det`, or `lsp`. `seam.blastRadius` — on by default.

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
