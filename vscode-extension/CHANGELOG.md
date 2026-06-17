# Changelog

All notable changes to the Seam extension. Distributed as a `.vsix` via
[GitHub Releases](https://github.com/Scorbutics/seam/releases) — experimental, not on the Marketplace.

## 0.2.0

Codebase mode grew up: the extension now maps **intent footprints** across a repo, not just diffs.

- **Intent footprints** — analyze from a cursor anchor, a whole module, or a natural-language intent;
  Seam traces the footprint across the repo and renders it as seams (anchor → spine → culmination),
  with off-domain seams dimmed and unresolved edges flagged honestly (`SUGGESTED` / blindspots).
- **Auto-map intent** — grow a footprint toward a question; the spine is laid out in directed order
  with a primary pointer per seam.
- **Language-agnostic structure** — code-identity and definition extraction now go through tree-sitter
  for all supported languages (TS/JS, Java, Ruby, C, C++), with a regex fallback.
- **Better anchor selection** — embedding-based recall is the default (graceful lexical fallback when
  the embedding model isn't present), with a probe→judge funnel and an honest `noFlow` signal when an
  intent has no traceable spine.
- **Expand** consumers (who uses this) and dependencies (what this uses), and cross-boundary suggestions.
- Map-fidelity fixes: directed spine order, per-seam primary pointer, caller-fan cap.

Diff review is unchanged in spirit: seam colours on the native diff, a seam tree, click-to-diff,
and an auto-saved/restored last run per workspace.

## 0.1.0

Initial experimental release.

- Diff review: role-coloured decorations (gutter + scrollbar overview), CodeLens seam labels, and a
  clusters → seams → hunks tree with click-to-diff and seam focus.
- Bundled TypeScript engine (esbuild) run on VS Code's own Node — no `bun`, no checkout.
- LLM passes served via a `claude`/`copilot` CLI or borrowed through VS Code's Language Model API.
