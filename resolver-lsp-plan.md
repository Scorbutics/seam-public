# Resolver refactor — externalise stack-specific resolution to LSP

## Goal
Stop reimplementing each stack's module/symbol resolution inside Seam. Resolve through the language's
**real** server (LSP) so `@/` aliases, `node_modules`, Python `sys.path`, Go modules, `#include`
paths, etc. are the *server's* job — not ours. Keep a thin deterministic **floor** for offline /
headless / no-server-installed. Validated by the spike (`/tmp/lsp_spike.py`): Python drove a real
`typescript-language-server` offline and resolved the `@/lib/services/payments` alias to its file —
zero custom resolver code. Cost: ~5.5s one-time project index, then ~1ms/query (amortised by a daemon).

## Principles
1. **Rely on the bricks.** Per-language code shrinks to a *registry entry* (launch command + a few
   markers), never resolution *logic*.
2. **Deterministic floor, LSP precision.** Floor = relative paths + the big-stack aliases we already
   have (works with no server, no toolchain, instantly). LSP = correctness + cross-language, when a
   toolchain is present. The floor is never removed — it's the headless/cold fallback.
3. **Direction-aware** (the §lsp-references-monorepo-blind lesson): use LSP **go-to-definition**
   (down / resolve — reliable). Keep deterministic **grep** for who-imports-this (up / discover —
   find-references is monorepo-blind). The Resolver is a *down/resolve* abstraction only.
4. **Cross-language = tree-sitter (find) + LSP (resolve).** Tree-sitter grammars find the symbols /
   imports / calls (the `FactsProvider`, already pluggable); LSP resolves them. Both are per-language
   *config*, not logic.

## Architecture

```
caller (build_dependency_graph, scan_consumers' resolve step)
        │  resolve_module(repo, importing_file, source)            ← unchanged call shape
        ▼
   Resolver  (strategy)
     ├── DeterministicResolver   relative + _pkg_map + tsconfig paths   (the floor; current code)
     └── LspResolver
            ├── ServerRegistry        language → launch spec + markers + extensions
            ├── LspPool (daemon)      one server per (language, project root), lazy, warm, reused
            └── LspClient             generic JSON-RPC/stdio: initialize/didOpen/definition/shutdown
```

- **`Resolver` (Protocol)** — `resolve_module(repo, importing_file, source) -> str | None` (drop-in
  for today's `resolve_module`). Phase-1.5: add `resolve_symbol(repo, file, line, col) -> (file,line)`
  for the exact definition (lets us skip re-parsing the target file).
- **`DeterministicResolver`** — wraps today's `resolve_module` logic verbatim (no behaviour change).
- **`LspResolver`** — for `resolve_module`: locate `source` in `importing_file`, `textDocument/definition`
  on the module string → target file (the spike proved this returns the file). Falls back to the
  deterministic resolver on miss/timeout/no-server.
- **`LspClient`** — the ~120-line generic client from the spike (string-aware, handles server→client
  requests like `workspace/configuration`). Language-agnostic.
- **`LspPool`** — keyed by `(language, project_root)`. Lazy-starts + `initialize`s a server, keeps it
  warm, reuses it for every query in that project, shuts it down at process exit (and after an idle
  TTL). This is what turns the 5.5s index into a once-per-session cost.
- **`ServerRegistry`** — the only per-language surface (see table). Resolves: file ext → language →
  launch command + how to obtain the server + project-root markers + the toolchain pin.

## Selection / fallback
`--resolver det | lsp | auto` (config `seam.resolver`):
- `det` — today's behaviour (default until LSP is proven across the v1 languages).
- `lsp` — LSP only (errors surfaced, no silent fallback — for validating a language).
- `auto` — try LSP if a server is configured **and** obtainable **and** the toolchain is present; else
  the deterministic floor. The eventual default.

## Server registry — v1 languages (barebones)
`status`: **full** = implemented+validated · **impl** = implemented, lightly tested · **scaffold** =
registry entry only (command + markers + ext), not exercised. Each entry is *config*, no logic.

| language | ext | LSP server (launch) | obtain | languageId | root markers | toolchain pin / caveat | status |
|---|---|---|---|---|---|---|---|
| **TypeScript/JS** | .ts .tsx .js .jsx .mts .cts | `typescript-language-server --stdio` | `bun x` (npm) | typescript / typescriptreact / javascript | tsconfig.json, jsconfig.json, package.json | **MUST** point at the *project's* `node_modules/typescript/lib/tsserver.js` (init `tsserver.path`) — the bundled TS failed on `moduleResolution: "bundler"` | **full** (MVP) |
| **Python** | .py .pyi | `pyright-langserver --stdio` (alt `pylsp`) | `bun x` (npm: pyright) | python | pyproject.toml, setup.py, setup.cfg, requirements.txt, Pipfile | venv detection (pyright: `python.venvPath`/`pythonPath`) | **impl** (Phase 2) |
| **Java** | .java | `jdtls` (eclipse.jdt.ls) | system / download | java | pom.xml, build.gradle(.kts), settings.gradle, .project | JDK (`JAVA_HOME`); heavy — needs a data/workspace dir + build import; slow first index | **scaffold** |
| **Kotlin** | .kt .kts | `kotlin-language-server` | system / download | kotlin | build.gradle.kts, settings.gradle.kts, pom.xml | shares the Gradle project with Java; server less mature/slow | **scaffold** |
| **Ruby** | .rb .rake | `ruby-lsp --stdio` (alt `solargraph stdio`) | `gem` / bundler | ruby | Gemfile, .ruby-version, Rakefile | rbenv/bundler; run under the project's Ruby | **scaffold** |
| **C** | .c .h | `clangd` | system (llvm) | c | compile_commands.json, .clangd, compile_flags.txt, CMakeLists.txt | **needs a compile DB** (`compile_commands.json`) for real `#include`/symbol resolution; without it, degraded → deterministic floor | **scaffold** |
| **C++** | .cpp .cc .cxx .hpp .hh .hxx | `clangd` | system (llvm) | cpp | compile_commands.json, .clangd, CMakeLists.txt | same compile-DB requirement as C; the hardest (no implicit project model) | **scaffold** |

Notes baked into the registry:
- **Obtain strategy** per entry: `bun x <pkg>` for npm servers (TS, pyright) — auto-fetches, no global
  install; system-PATH for the rest; if neither resolves → that language degrades to the deterministic
  floor (and a one-line "LSP unavailable for <lang>, using floor" note, never a hard failure).
- **Resolution unit differs, go-to-def is uniform**: TS/JS/Python/Ruby = import statements; Java/Kotlin
  = package imports; C/C++ = `#include`. The *finder* (tree-sitter / `FactsProvider`) is per-grammar;
  the *resolver* (go-to-def at the reference position) is uniform.

## Phasing
- **Phase 0 — interface, no behaviour change.** Extract `Resolver` Protocol; wrap current logic as
  `DeterministicResolver`; route every `resolve_module` caller through a resolver instance. Default
  stays deterministic. Green = the existing suite unchanged.
- **Phase 1 — LspResolver + TS (MVP).** Promote `/tmp/lsp_spike.py` → `src/lsp/client.py` (generic) +
  `src/lsp/pool.py` (daemon) + `src/lsp/registry.py` (TS entry). `--resolver lsp`. Validate on
  private-app + cal.com: LSP resolution == deterministic on the cases the floor handles, **and**
  resolves cases the floor can't (exotic aliases). Add a parity test (det vs lsp on a fixture).
- **Phase 1.5 — `auto` + symbol resolution.** `auto` mode (lsp-if-available else floor). Add
  `resolve_symbol` (go-to-def on the symbol → exact def file+line) and let `build_dependency_graph`
  use it to skip re-parsing the target.
- **Phase 2 — Python (pyright).** Add the Python registry entry; validate on a real Python repo.
  Confirms the abstraction is genuinely language-agnostic (two stacks through one client).
- **Phase 3 — scaffolds.** Land the Java/Kotlin/Ruby/C/C++ registry entries (command + markers + ext),
  each behind `auto` with graceful "unavailable → floor". Smoke-test whichever servers are installable;
  the rest ship as documented scaffolds with a per-language follow-up.
- **Phase 4 — daemon hardening + extension provider (later).** Idle-TTL + crash-restart + concurrency
  in `LspPool`; optional `LspResolver` variant that uses the extension's *warm* VSCode server (via the
  existing `executeDefinitionProvider` bridge) instead of spawning, for interactive runs.

## Risks & mitigations
- **Index cost (5.5s TS; Java/clangd worse).** → `LspPool` daemon (pay once per session); `det` floor
  for fast/headless; `auto` only spins LSP when its extra correctness is needed.
- **Toolchain dependency** (node_modules for TS, JDK for Java, compile DB for C/C++). → graceful
  degrade to the floor + a visible note; never a hard failure. The floor guarantees a baseline always.
- **Wrong server TS version** (bundled TS ≠ project's). → pin the project's compiler via the registry's
  toolchain rule (proven necessary in the spike).
- **Server crash / hang.** → per-query timeout + pool restart; on repeated failure, mark the language
  floor-only for the run.
- **find-references still blind.** → out of scope; the Resolver is resolve-only, discovery stays grep.
- **Determinism of tests.** → unit-test `DeterministicResolver` (as today, hermetic); LSP paths get an
  opt-in integration test gated on server availability (skip if absent), never in the core CI gate.

## Files
- New: `src/lsp/client.py`, `src/lsp/pool.py`, `src/lsp/registry.py`, `src/resolver.py` (Protocol +
  Deterministic + Lsp).
- Touched: `src/import_scan.py` (route `resolve_module` through the resolver; keep the functions as the
  `DeterministicResolver` body), `decompose.py` (`--resolver`), extension settings (`seam.resolver`).
- Unchanged: tree-sitter facts, the scan's *discovery* (grep) path, the seam/contract layers.

## MVP cut
TypeScript only, Phases 0–1 (+1.5 `auto`). That alone retires the hand-written tsconfig-paths resolver
behind a real server and proves the architecture. The other four v1 languages land as registry
scaffolds (Phase 3) so the shape is fixed and each is a small, isolated follow-up.
