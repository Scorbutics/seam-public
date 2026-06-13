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
From an anchor (a symbol, or a whole module file), trace its footprint across the codebase in a single
static scan and decompose it into seams — who consumes it, what it wires, where the intent lives.
Honest about gaps: statically-opaque edges come back as `SUGGESTED`/`blindspots`, never asserted.

- `repo`, `anchorFile` (required), `symbol`, `intent`, `depth`, `engine`

### `grow_intent`
The LLM-in-the-loop counterpart to `intent_footprint`. Where `intent_footprint` takes one static scan,
this **grows** a footprint toward a question: seed from an anchor symbol, then let the model
iteratively pick the next consumer (up) or dependency (down) to follow until the footprint covers the
answer, and decompose the grown result. This is Seam's auto-orchestration loop — every move is the
model's, served by **your** model via sampling. LLM-only (no `det`); needs a sampling-capable client.

- `repo`, `anchorFile`, `symbol`, `intent` (required), `maxSteps`, `engine` (`hybrid`/`llm`)

All tools return two content blocks: a short human summary, and the full Seam JSON model.

## The LLM question — det vs sampling

Seam's pipeline makes its *own* LLM calls (cluster labelling, reconciliation, and the auto-grow
orchestration moves). The server offers two reaches, and **`det` is the recommended default** for the
diff/footprint tools — most agents want the *structure* (seams, roles, wiring), not Seam's prose, and
`det` is offline, instant, and needs no model:

| engine          | how the passes run                                                            |
|-----------------|-------------------------------------------------------------------------------|
| `det` (default) | no LLM at all — fully deterministic (not available for `grow_intent`)         |
| `hybrid`/`llm`  | **borrows the calling client's model via MCP sampling** (`sampling/createMessage`) |

The `hybrid`/`llm` path needs a client that supports **sampling**; otherwise the tool returns a clear
error telling you to use `det`. No nested `claude -p`, no API key — it reuses the caller's model.

It runs over the engine's **interactive bridge**: the server spawns the engine with `--llm-bridge DIR`,
and the engine drops one request file per pass and blocks while the server samples the client's model
and writes the answer back. Unlike the older batch handshake (`--emit-prompts` → answer-all →
`--inject-llm`, still used by the `seam` skill), an interactive round-trip can drive **in-loop**
features where the next prompt depends on the previous answer — which is exactly what `grow_intent`'s
orchestration needs. Implementation: [`src/sampling.ts`](src/sampling.ts), engine side
[`InteractiveHostBus`](../ts/src/core/llm.ts).

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
bun test/sampling.ts    # proves the interactive bridge: the client's sampled labels drive a hybrid diff
bun test/autogrow.ts    # proves grow_intent's orchestration loop is served by the client over the bridge
```
