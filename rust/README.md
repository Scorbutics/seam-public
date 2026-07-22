# Seam Rust core

napi-rs in-process addon — the Rust half of the [migration](../../). STRUCTURE (parse / resolve / grow /
couple) moves here; the TS shell keeps semantics + I/O + render. Ported byte-identical against the TS engine,
one vertical slice at a time (strangler).

## Architecture

A Cargo **workspace** — crate boundaries enforce the layering the TS engine lost, so no crate can reach into
another's internals (the strongest guard against tight coupling). We adapt as we port; we do **not** translate
TS as-is (e.g. TS's module-global `_INDEX_CACHE` became a per-repo `Workspace`).

| crate | responsibility | deps |
|---|---|---|
| `seam-fs` | file enumeration (git walk) | — |
| `seam-lang` | language layer: `LanguageProvider` (stateless syntax) + `ModuleResolver` (stateful per-repo resolution) traits, pure domain types, per-language modules (`java/`, `typescript/`, `ruby/`), tree-sitter substrate | `seam-fs` |
| `seam-resolve` | language-**agnostic** cross-file logic (`Workspace`, import index, consumers) — dispatches only through traits | `seam-lang`, `seam-fs` |
| `seam-napi` | thin binding: wire DTOs + entry points, the only crate with napi-derive | all |

Adding a language = one small module implementing the traits. The domain types carry no napi; the boundary converts.

## Status

- **Phase 0 (done)** — de-risked napi + AST parity. See below.
- **Phase 1 (in progress)** — first slice: `--query consumers`, foundation-up.
  - ✅ Java `imports()` (`src/lang/java.rs`) — **8141/8141 Keycloak `.java` files byte-identical** to TS `parse_imports` (`bun rust/parity/imports.ts`).
  - ✅ Repo walk (`src/walk.rs`) — shells to the same `git ls-files` (tracked ∪ untracked-not-ignored), SKIP_DIRS-pruned → byte-identical file set by construction.
  - ✅ Java `floor_resolve` + FQN index (`_java_index`) — **126,358/126,358 resolutions byte-identical** to TS `floor_resolve` over the full corpus (FQN drop, same-package + wildcard bare names) (`bun rust/parity/resolve.ts`).
  - ✅ TS/JS `imports()` (`src/lang/typescript.rs`) — named `{…}`/`as`, barrel re-exports, dynamic `import()` — **3132/3132 files byte-identical** (174 Seam `ts/src` + 2958 node_modules) (`bun rust/parity/imports_ts.ts`).
  - ✅ Ruby `imports()` (`src/lang/ruby.rs`) — `require`/`require_relative`/`autoload` — **1861/1861 files byte-identical**. Min-set import parsers now complete (C/C++ are LSP-only, no imports). Generic per-ext harness: `bun rust/parity/imports_any.ts <files…>`.
  - ✅ Ordered walk (`seam-fs::source_files`) — a sorted pre-order DFS (files before subdirs) with `git ls-files` as the FILTER, matching TS's traversal order (which the consumer scan is order-sensitive to).
  - ✅ Import index (`seam-resolve::ImportIndex`) + `scan_consumers` (`Workspace`) — **399/400 Keycloak Java anchors byte-identical** (`bun rust/parity/consumers.ts`). The ordered walk, by-name inversion, resolve→FULL/SUGGESTED, dedup, and barrel-following are all byte-identical. The single mismatch is a JS import Rust marks SUGGESTED because the **TS module resolver** isn't ported yet (it would resolve-and-skip) — the next piece.
  - ▢ next: the TS module resolver (package map + tsconfig paths + extension probing) → full `scan_consumers` parity; then the Java callsite graph (tree-sitter).

## Phase 0 results

| Assumption | Verdict |
|---|---|
| **bun can load an in-process Rust napi addon** | ✅ `bun` loads `seam_phase0.node`, calls `hello`/`add`; napi auto-camelCases `parse_kinds → parseKinds`. |
| **native tree-sitter == web-tree-sitter AST (parity)** | ✅ **exact** — 60/60 random Keycloak Java files: every node **kind, field, and byte span** identical. Grammar structure matches on **100%** of files; the only offset diffs are on non-clean-UTF-8 files and are a *harness artifact* (see below), not a grammar issue. |

### The parity finding that matters for Phase 1

web-tree-sitter parity is **only** exact when the native grammar is the **same source version** the wasm was
built from. Seam bundles `tree-sitter-wasms@0.1.13` → **`tree-sitter-java@0.20.2`**. The current crate
(`0.23.5`) renamed the `if/while` condition node `condition → parenthesized_expression`, which diverged 2/1313
nodes. Fix (done here, the Phase 1 pattern): **vendor `parser.c` from the matching grammar version** and compile
it against this crate's single `tree-sitter` 0.25 runtime (`vendor/java/`, `build.rs`). Vendoring *only*
`parser.c` — not the old crate — avoids a duplicate-C-runtime link clash.

- **tree-sitter core:** `0.25` (matches web-tree-sitter `0.25.10`).
- **Grammar source pins (from `tree-sitter-wasms@0.1.13`):** java `^0.20.2` · javascript `^0.20.3` · (Phase 1 vendors cpp / c / ruby / typescript the same way — check each `package.json` pin).

### The offset artifact (a Phase 1 detail, not a blocker)

The harness passes a JS string across napi, which re-encodes it — so byte offsets inflate on non-UTF-8-clean
files (rust `5921` vs the true `5905`). Node **structure is always identical**. The real core sidesteps this
entirely: it **reads raw file bytes** and reports true UTF-8 byte offsets — the same unit web-tree-sitter already
reports. The harness classifies this as 🟡 *structure-identical* (exit 1) vs ❌ *grammar divergence* (exit 2).

## Build & run

```sh
. "$HOME/.cargo/env"
cd rust && cargo test --release            # all crate unit tests
cargo build --release                       # → target/release/libseam_napi.so
cp target/release/libseam_napi.so seam_core.node
# byte-identical harnesses (need ../ts/node_modules — symlink the main checkout's, or `bun install`):
bun parity/parity.ts      [file.java]      # native vs web-tree-sitter AST
bun parity/imports_any.ts <files…>         # imports, any language (importsOf dispatches by ext)
bun parity/resolve.ts     [repo]           # Java floor_resolve vs TS
```

## Phase 1 hand-off

1. **Vendor the remaining grammars** (cpp/c/ruby/typescript) at their `tree-sitter-wasms@0.1.13` versions, same pattern.
2. **Read raw file bytes in Rust** (not strings across napi) → byte-accurate offsets, no re-encode artifact.
3. **The real boundary types** — `ScanQuery` in / `Seams` out as napi structs (this spike only passes strings).
4. **Per-platform prebuilt `.node`** binaries (darwin/linux/win × x64/arm64) for the `.vsix` — the napi-rs decision's distribution cost.
