# Distributing the Seam engine

The engine is a **stateless TypeScript library + CLI**. Clients (VS Code extension, the Claude/Copilot skills, a
future IntelliJ plugin) are thin and reach it one of two ways. There is **no daemon** — the engine
holds no resident state; each invocation is independent.

## 1. Run from source (bun on PATH)

How the VS Code extension runs today: spawn `bun ts/src/cli/decompose.ts …`. Requires a Seam
checkout and `bun` installed (found on PATH or at `~/.bun/bin/bun`).

```sh
bun ts/src/cli/decompose.ts --git HEAD~1 --classifier det --emit-seams /tmp/seams.json
```

## 2. Esbuilt CJS bundle (recommended for non-VS Code clients)

`bun run build` (= `bun build.mjs`) esbuilds the engine into one **`ts/dist/seam.cjs`** plus a grammar
pack at `ts/dist/wasm/`. It needs a `bun`/`node` runtime to execute, but no source checkout and no
`bun install`. Preferred over re-transpiling the source CLI per call.

```sh
cd ts && bun run build          # → ts/dist/seam.cjs  (+ dist/wasm/ grammar pack)
SEAM_WASM_DIR="$PWD/dist/wasm" bun dist/seam.cjs --file change.patch --classifier det --emit-seams /tmp/seams.json
```

`dist/` is gitignored (reproducible). Build it in CI and ship it alongside each client. A client
locator runs it with `SEAM_WASM_DIR` set automatically.

### Why not `bun build --compile`?

A single `--compile` binary is **not** used: it drops web-tree-sitter's *core* `tree-sitter.wasm` (which
web-tree-sitter loads relative to its package dir, absent in a baked binary), so the binary **aborts on
the first parse** (`ENOENT … /$bunfs/root/tree-sitter.wasm`). The esbuild bundle avoids this by keeping
`web-tree-sitter` **external** — it resolves from `node_modules` and finds its own wasm — and copies the
**grammar** pack next to the bundle (pointed at by `SEAM_WASM_DIR`). So unlike the old compiled binary,
the bundle **keeps full tree-sitter facts for all five languages**, not the regex fallback.

For a host that has its own AST (the VS Code extension's language-server facts via `--facts external`,
or an IntelliJ plugin's PSI), grammar embedding is moot — the host supplies the facts directly.

## 3. Host-served LLM (no `claude`/`copilot` subprocess)

For LLM passes (hybrid/llm engines) the engine normally spawns a `claude -p` / `copilot` subprocess
([`ts/src/core/llm.ts`](../ts/src/core/llm.ts)). When the *caller already has a model* (a Claude Code
skill, or the VS Code extension lending the editor's model), use the **host-bus** contract instead — the engine
emits the prompts it would send and applies nothing, the caller answers them, and the engine replays
the answers:

```sh
seam … --classifier hybrid --emit-prompts prompts.json     # phase 1: record prompts, run nothing
#   caller completes each pass with ITS OWN model →   answers.json
seam … --classifier hybrid --inject-llm answers.json --emit-seams seams.json   # phase 2: replay
```

This is how the `seam` skill borrows the live session's model — no second model, no API key, uses the
caller's LLM. The VS Code extension uses the same two-phase host-bus handshake.

## Which engine for which client

| Client            | Reach            | Default engine | Facts source                |
|-------------------|------------------|----------------|-----------------------------|
| VS Code extension | bun from source  | hybrid         | editor LSP (`--facts external`) |
| Claude/Copilot skill | bun from source | hybrid       | tree-sitter; host-bus for intent |
| IntelliJ (future) | single binary    | det → hybrid   | PSI via `--facts external`  |
| CLI / scripts     | either           | hybrid         | tree-sitter or regex        |
