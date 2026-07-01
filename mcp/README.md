# Seam MCP server

Lets **any LLM agent** consult Seam — review a diff, trace an intent footprint, or ask a structural
question about the codebase (who calls X, can A reach B, a module's boundary, the subsystem around X,
how A and B differ) — over the same `--emit-seams` JSON contract the VS Code extension consumes
([docs/SEAM_JSON_CONTRACT.md](../docs/SEAM_JSON_CONTRACT.md)).

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
- `impact` — annotate each seam with the change's codebase impact: transitive consumers **not in the PR**,
  plus **cross-stack coupling** (a backend write whose frontend reader the PR didn't touch — the "you
  changed the write, not the read" signal). Needs `repo`. The one thing a diff-only or codebase-only tool
  can't produce; the structural bridge between this server's diff and codebase halves. Each flag is graded
  by a deterministic relevance floor (relevant / unknown / provably-irrelevant→suppressed) so it isn't noise.
- `triage` — with `impact`: an LLM pass over only the `unknown` relevance residual, reclassifying each
  relevant/irrelevant (needs engine `hybrid`/`llm` or a local binary). The floor handles the easy 80%; this
  is the exception handler, not the firehose.

> Both codebase tools below emit the **deterministic skeleton** (`--skeleton`): the flood-fill region (when
> grown) + structural symbol-name labels + blindspots, *without* the LLM seam-intent tiering/labeling pass. The
> consumer here is **your** model, which re-derives tiers/labels from the symbols itself — validated A/B
> to give an equal-or-better answer at ~⅓ the tokens, while skipping the ~18s pass. The full prose-label
> + tier-grouping enrichment is reserved for the human VS Code visualization, which can't re-tier on the fly.

### `intent_footprint`
From an anchor (a symbol, or a whole module file), trace its footprint across the codebase in a single
static scan and decompose it into seams — who consumes it, what it wires, where the intent lives.
Honest about gaps: statically-opaque edges come back as `SUGGESTED`/`blindspots`, never asserted.

- `repo`, `anchorFile` (required), `symbol`, `intent`, `depth`, `crossFramework`, `engine`
  (`crossFramework` = opt-in LLM cross-framework coupling, off by default — the deterministic floor
  already couples DB tables + HTTP routes across the stack; with it on, the LLM pass is fallback-gated
  (fires only on floor-blind nodes, budget-capped) so it scales. Enable for a cross-stack question the
  trace left open.) Each reply ends with a `⏱ timing` block (total + per-phase durations).

### `grow_intent`
The LLM-in-the-loop counterpart to `intent_footprint`. Where `intent_footprint` takes one static scan,
this **grows** a footprint toward a question: seed from an anchor symbol, then let the model
iteratively pick the next consumer (up) or dependency (down) to follow until the footprint covers the
answer, and decompose the grown result. This is Seam's auto-orchestration loop — every move is the
model's, served by **your** model via sampling. LLM-only (no `det`); needs a sampling-capable client.

- `repo`, `anchorFile`, `symbol`, `intent` (required), `maxSteps`, `crossFramework`, `engine` (`hybrid`/`llm`)
  (`crossFramework` as above — opt-in cross-framework coupling, off by default.)

### Structural shapes (offline/deterministic)

Non-flow questions answered as **projections over the resolved graph** — each correct where grep gives
false-positives and where an embedding/RAG index can only guess, and each **honest** (`noStructure` /
`unreachable` route you to grep rather than fabricating a result). All are `det`, no LLM, no `engine` knob.

- **`find_consumers`** (`repo`, `anchorFile`, `symbol`, `recall?`) — the RESOLVED set of callers of a
  symbol, each tier-labelled (`RESOLVED_FULL` / `PARTIAL` / `SUGGESTED`). `recall: true` adds
  name-grounded UNVERIFIED leads (a separate list) for languages without symbol imports (Ruby/C/C++).
- **`find_dependencies`** (`repo`, `anchorFile`, `symbol`) — the symmetric inverse: the RESOLVED set of
  what a symbol depends on / calls (its out-edges), tier-labelled. `noStructure` reason `none` = a leaf.
- **`impact_of`** (`repo`, `anchorFile`, `symbol`, `depth?`) — the TRANSITIVE blast radius (what's
  affected if X changes): the transitive consumer closure rolled up by file, the `surface` it ripples to,
  and the `gaps` (opaque callers where the view is incomplete). The refactoring safety net.
- **`refactor_facts`** (`repo`, `anchorFile`, `symbol`) — the one-call FACTS bundle for "how to refactor
  X": impact + dependencies + contract together. Returns facts only — the change PLAN over them is a
  judgement for the caller/model, not something Seam decides.
- **`can_reach`** (`repo`, `anchorFile`, `symbol`, `toSymbol`, `toFile?`, `maxHops?`) — can FROM reach TO?
  A verified yes/no **+ a witness path**. Three distinct negatives: `unreachable` (real), `exhausted`
  (budget — inconclusive), `no-out-edges` (FROM unanalysable).
- **`module_contract`** (`repo`, `anchorFile`) — a module's boundary: used exports + consumers, **dead
  exports**, outbound deps, and fan-in/out (afferent/efferent coupling).
- **`subsystem`** (`repo`, `anchorFile`, `symbol`, `depth?`) — the cohesive cluster around a symbol, split
  into core vs periphery by the parameter-free weak-community rule (deterministic, local).
- **`compare_symbols`** (`repo`, `anchorFile`, `symbol`, `toFile`, `toSymbol`, `depth?`) — how two symbols
  differ by what they depend on (shared / A-only / B-only) + a similarity score.

### `ask` — the natural-language front door

From a plain question, **routes** to the right shape and runs it — or routes **away** to grep (lexical)
/ RAG (semantic) when structure isn't the right tool. Routing is a model judgement, so this is the one
shape tool that needs an LLM (served like `grow_intent`: a local `claude`/`copilot` binary, else your
model via sampling). When you already know the shape, call its tool directly to skip the routing step.

- `repo`, `question` (required), `engine` (`hybrid`/`llm`)

All tools return two content blocks: a short human summary, and the full Seam JSON model.

## Learned adapters (CLI companion)

When a `hybrid`/`llm` run learns data-coupling adapters for an unknown/homemade framework, they persist to
the repo's `.seam/` (LLM-once → deterministic-forever; see the main README). Inspect & promote them with
the `seam-adapters` CLI — `bun ts/src/cli/adapters.ts list | promote <name> | where` (the installer adds a
`seam-adapters` shim on PATH). The learned adapters are plain, named, reviewable records — not a hidden index.

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

Engine resolution order: `$SEAM_BIN` → the esbuilt `ts/dist/seam.cjs` bundle (build with
`cd ts && bun run build`; run via `bun` with `SEAM_WASM_DIR` set automatically) → `bun` + the source
CLI (~40ms startup either way; the real cost is the tree-sitter scan, not startup). Set `SEAM_BIN` to
ship the server without a checkout. *(Note: the locator deliberately does **not** auto-prefer a
`ts/dist/seam` single binary — `bun build --compile` drops web-tree-sitter's core wasm and aborts on
the first parse, so a stray broken build can't poison the server; opt a working packaged engine in via
`SEAM_BIN`.)*

### Register with an MCP client

`.mcp.json` (Claude Code, and other MCP clients):

```json
{
  "mcpServers": {
    "seam": {
      "command": "bun",
      "args": ["/abs/path/to/code-review-sort/mcp/src/server.ts"]
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
