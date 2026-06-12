# Distributing the Seam engine

The engine is a **stateless TypeScript library + CLI**. Clients (VS Code extension, MCP server, a
future IntelliJ plugin) are thin and reach it one of two ways. There is **no daemon** — the engine
holds no resident state; each invocation is independent.

## 1. Run from source (bun on PATH)

How the VS Code extension runs today: spawn `bun ts/src/cli/decompose.ts …`. Requires a Seam
checkout and `bun` installed (found on PATH or at `~/.bun/bin/bun`).

```sh
bun ts/src/cli/decompose.ts --git HEAD~1 --classifier det --emit-seams /tmp/seams.json
```

## 2. Single self-contained binary (recommended for non-VS Code clients)

`bun build --compile` produces one ~100MB executable with the bun runtime baked in — no checkout, no
bun install, no PATH lookup. This is the simplest thing for a JVM plugin (IntelliJ) or a packaged MCP
server to shell out to.

```sh
cd ts && bun run build          # → ts/dist/seam
./ts/dist/seam --file change.patch --classifier det --emit-seams /tmp/seams.json
```

The binary is gitignored (large, reproducible). Build it in CI per-platform and ship it alongside
each client, or let the client build it on first run.

### Caveat: tree-sitter grammars are not embedded

The compiled binary cannot bundle the `.wasm` grammars from `tree-sitter-wasms`. With the binary
alone, `--facts-engine treesitter` **falls back to the regex facts producer** (it prints
`tree-sitter grammars not found; using regex facts`). This matters per client:

- **det + regex facts** (the default, and the MCP server's offline floor) is fully self-contained —
  ship just the binary.
- **Richer AST facts** need either (a) the `tree-sitter-wasms` package available next to the binary,
  or (b) facts supplied by the host — which is exactly what the VS Code extension does via its
  `ExternalFactsProvider` (`--facts external`), feeding facts from the editor's language server. An
  IntelliJ plugin would do the same from PSI, so it never depends on the embedded grammars.

## 3. Host-served LLM (no `claude`/`copilot` subprocess)

For LLM passes (hybrid/llm engines) the engine normally spawns a `claude -p` / `copilot` subprocess
([`ts/src/core/llm.ts`](../ts/src/core/llm.ts)). When the *caller already has a model* (a Claude Code
skill, or an MCP client that supports sampling), use the **host-bus** contract instead — the engine
emits the prompts it would send and applies nothing, the caller answers them, and the engine replays
the answers:

```sh
seam … --classifier hybrid --emit-prompts prompts.json     # phase 1: record prompts, run nothing
#   caller completes each pass with ITS OWN model →   answers.json
seam … --classifier hybrid --inject-llm answers.json --emit-seams seams.json   # phase 2: replay
```

This is how the `seam-review` skill borrows the live session's model, and how the MCP server maps
LLM passes onto MCP **sampling** — no second model, no API key, uses the caller's LLM. See
[`mcp/README.md`](../mcp/README.md).

## Which engine for which client

| Client            | Reach            | Default engine | Facts source                |
|-------------------|------------------|----------------|-----------------------------|
| VS Code extension | bun from source  | hybrid         | editor LSP (`--facts external`) |
| MCP server        | single binary    | det (offline)  | regex floor; sampling for intent |
| IntelliJ (future) | single binary    | det → hybrid   | PSI via `--facts external`  |
| CLI / scripts     | either           | hybrid         | tree-sitter or regex        |
