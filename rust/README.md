# Seam Rust core — Phase 0 (de-risk spike)

Proves the two load-bearing assumptions of the [Rust migration plan](../../) **before** any engine code is
written. Not the real crate layout — a single throwaway crate that answers two questions.

## Results

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
cd rust && cargo build --release           # → target/release/libseam_phase0.so
cp target/release/libseam_phase0.so seam_phase0.node
bun parity/parity.ts [file.java]           # diff harness: native vs web-tree-sitter AST
```

## Phase 1 hand-off

1. **Vendor the remaining grammars** (cpp/c/ruby/typescript) at their `tree-sitter-wasms@0.1.13` versions, same pattern.
2. **Read raw file bytes in Rust** (not strings across napi) → byte-accurate offsets, no re-encode artifact.
3. **The real boundary types** — `ScanQuery` in / `Seams` out as napi structs (this spike only passes strings).
4. **Per-platform prebuilt `.node`** binaries (darwin/linux/win × x64/arm64) for the `.vsix` — the napi-rs decision's distribution cost.
