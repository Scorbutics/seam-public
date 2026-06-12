# Seam MCP server

Lets **any LLM agent** consult Seam about a diff or an intent footprint, over the same
`--emit-seams` JSON contract the VS Code extension consumes ([docs/SEAM_JSON_CONTRACT.md](../docs/SEAM_JSON_CONTRACT.md)).

Thin by design: it locates the **stateless** Seam engine (the compiled binary or the source CLI) and
shells out once per call. **No daemon, no resident state.** See [docs/DISTRIBUTION.md](../docs/DISTRIBUTION.md)
for how the engine is reached.

## Tools

### `decompose_diff`
Group a git diff into seams (one technical intent each), labelling every hunk by role
(`core`/`link`/`environment`/`test`/`noise`) with wiring and optional blast-radius.

- `diff` — raw unified-diff text, **or**
- `repo` + `range` — a repo path and a git revision range (`HEAD~1`, `main...HEAD`)
- `engine` — `det` (default, offline), `hybrid`, or `llm`
- `blastRadius` — also find files *outside* the diff that import changed symbols

### `intent_footprint`
From an anchor (a symbol, or a whole module file), trace its footprint across the codebase and
decompose it into seams — who consumes it, what it wires, where the intent lives. Honest about gaps:
statically-opaque edges come back as `SUGGESTED`/`blindspots`, never asserted.

- `repo`, `anchorFile` (required), `symbol`, `intent`, `depth`, `engine`

Both tools return two content blocks: a short human summary, and the full Seam JSON model.

## The LLM question — det vs sampling

Seam's pipeline makes its *own* LLM calls (cluster labelling, reconciliation). The server offers two
reaches, and **`det` is the recommended default** — most agents want the *structure* (seams, roles,
wiring), not Seam's prose, and `det` is offline, instant, and needs no model:

| engine          | how the passes run                                                            |
|-----------------|-------------------------------------------------------------------------------|
| `det` (default) | no LLM at all — fully deterministic                                            |
| `hybrid`/`llm`  | **borrows the calling client's model via MCP sampling** (`sampling/createMessage`) |

The `hybrid`/`llm` path needs a client that supports **sampling**; otherwise the tool returns a clear
error telling you to use `det`. No nested `claude -p`, no API key — it reuses the caller's model. This
maps onto the engine's host-bus contract (`--emit-prompts` → answer → `--inject-llm`); the same
two-phase flow the `seam-review` skill uses. Implementation: [`src/sampling.ts`](src/sampling.ts).

## Run it

```sh
bun src/server.ts          # stdio MCP server
```

Engine resolution order: `$SEAM_BIN` → `ts/dist/seam` (build with `cd ts && bun run build`) → `bun`
+ the source CLI. Set `SEAM_BIN` to ship the server without a checkout.

### Register with an MCP client

`.mcp.json` (Claude Code, and other MCP clients):

```json
{
  "mcpServers": {
    "seam": {
      "command": "bun",
      "args": ["/abs/path/to/code-review-sort/mcp/src/server.ts"],
      "env": { "SEAM_BIN": "/abs/path/to/code-review-sort/ts/dist/seam" }
    }
  }
}
```

(`SEAM_BIN` is optional — omit it to run from source.)

## Tests

```sh
bun test/smoke.ts       # det path end-to-end over a real stdio MCP client
bun test/sampling.ts    # proves the host-bus ↔ sampling bridge drives the engine (no real LLM)
```
