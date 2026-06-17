# Changelog

All notable changes to the Seam extension. Distributed as a `.vsix` via
[GitHub Releases](https://github.com/Scorbutics/seam/releases) — experimental, not on the Marketplace.

## 0.2.2

Deeper resolution — DI bindings and modern ESM. (Engine improvements; the bundled engine carries them.)

- **Interface→impl (DI) reachability** — a footprint now extends *past* a `@Inject`/`@Autowired`/CDI
  interface to its concrete implementation (sole impl → resolved; multiple → an honest blindspot listing
  candidates; framework-generated, e.g. a Spring-Data repository → an honest terminal). Spines reach the
  real JPA/JMS/service classes, not just the DI seam.
- **NodeNext `.js`-ESM imports** — `import { x } from "./y.js"` now resolves to its `.ts` source (the
  modern TypeScript convention); previously these were invisible and footprints could come back isolated.
- **Dynamic `import()`** — `const { x } = await import("./y.js")` (lazy-loading / code-splitting /
  React.lazy / Next.js lazy routes) is now followed when the path is a string literal (computed paths
  stay an honest blindspot).

Found and validated by running Seam on its own engine (`build_dependency_graph`: 1 → 36 symbols).

## 0.2.1

Java codebase mode, hardened end-to-end on real apps (Jakarta EE + Spring). All engine-side, so the
bundled extension now actually traces Java flows — `v0.2.0` predated this work.

- **Java resolution floor** — deterministic FQN-import → file resolution (no LSP/toolchain needed),
  plus **same-package** (flat-layout, e.g. a controller + repository in one package) and **wildcard
  import** support.
- **Interfaces/enums/records** are recognised as type definitions, so a dependency on an interface
  resolves (previously dropped — injected repository/service interfaces vanished from footprints).
- **Interface→impl (DI) reachability** — a footprint now extends *past* a `@Inject`/`@Autowired`
  interface to its concrete implementation (sole impl → resolved; multiple → an honest blindspot listing
  candidates; framework-generated, e.g. a Spring-Data repository → an honest terminal). Spines reach the
  real JPA/JMS/routing classes, not just the DI seam.
- **Cross-language anchor recall** — embedding recall now enumerates definitions via tree-sitter for
  non-TS languages (it was near-blind on Java), so auto-anchor lands on the right Java symbol; and
  candidate recall now respects `.gitignore` and skips vendored/minified bundles.

Validated on `eclipse-ee4j/cargotracker` (booking / routing / handling flows culminate correctly) and
`spring-petclinic`. TS/JS behaviour unchanged.

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
