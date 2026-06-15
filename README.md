# Seam — review by intent

> **Stop scrolling diffs line-by-line. Review by intent, not by file.**

<p align="center">
  <img src="seam.gif" alt="Seam decomposing a Flask pull request into review seams — one intent, five seams, tests to skim, docs to skip" width="100%">
  <br>
  <em>A real <a href="https://github.com/pallets/flask/pull/5736">Flask pull request (pallets/flask#5736)</a>, decomposed into seams — review the cores, skim the tests, skip the docs.</em>
</p>

Seam takes a real change and presents it **decomposed into seams** — units of *one intent*,
each hunk labelled by role (**core / link / environment / test / noise**) with its wiring — so you
review *by intent* instead of scrolling file-by-file. It works on a **diff** (what you changed) and
on a **codebase footprint** (where an intent lives across the repo).

It **structures, it does not judge.** No score, no approval, no "the LLM reviewed it for you." It
only pays the tax of reconstructing a change's structure so a triangulating review can happen
without the linear scroll fighting it. The human still trusts.

The engine is a **stateless TypeScript library** (`ts/`). Every surface — the CLI, the VS Code
extension, the MCP server, a future IntelliJ plugin — is a thin client over **one versioned JSON
contract** (`--emit-seams`). See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full model and the
reasoning.

## Two modes

| Mode | Anchor | Answers |
|---|---|---|
| **Diff** | a unified diff / `git diff <range>` | *What does this change do, and how do I review it by intent?* |
| **Codebase** | a symbol or a module file | *Where does this intent live — who consumes it, what does it wire?* |

**Diff mode** groups the hunks of a change into seams. **Codebase mode** starts from an anchor
(a symbol, or a whole module) and traces its **intent footprint** across the repo — consumers and
dependencies — then decomposes *that* into seams. Codebase mode is **honest about static gaps**:
edges it can't resolve come back as `SUGGESTED` / `blindspots` (a boundary to verify), never asserted
as real.

## The five roles

| Role | What it is | Trust mechanism |
|---|---|---|
| **core** | The new/changed logic the change is about (incl. a *rule* — a guard/predicate/config that decides when/whether/which — however small) | Behavioral — does it work, is it complete |
| **link** | Joints wiring the new thing in (params across layers, call sites, adapters, type-routing) | Contract — do the integration points hold |
| **environment** | Ambient ripple (shared utils, globals, passive config/data, declarations) | Impact — what else does this affect |
| **test** | Code that *verifies* the change — it **covers** cores rather than being the change | Verification — CI runs it (skim), but is the coverage *real*? |
| **noise** | Renames, formatting, indentation | None — confirm it really is noise |

The boundary that matters: **"decides an outcome" → core** vs **"connects/routes" → link**. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the reasoning (and why `test` earned a role).

A *seam* = one core (its own hunk id is the seam id) plus the links/env that reference it —
**many-to-many** (a link can wire several cores). Per-seam **look-here flags** (never scores, just
"verify this"): *⚠ isolated core*, *dangling link*, *uncertain core* (role vote split), *⚠ untested
core*. The tool structures; the human judges.

## How it works

A change flows through a **deterministic shell** (parse + noise filter), a **classifier**, and a
**deterministic assembler** (`emit_seams_json`). Classification is **three passes**, and each runs on
one of three **engines** — `det`, `llm`, or `hybrid` (deterministic first, LLM cleanup on the
*residual* only) — set independently (`--cluster`, `--roles`, `--wiring`) or via the `--classifier`
preset:

| pass | **default** | det | llm | hybrid |
|---|---|---|---|---|
| **cluster** (grouping) | **llm** | components + structural labels (F1 ~0.68) | grouping + prose labels (**F1 ~0.98**) | det grouping + LLM **product-intent** labels |
| **roles** (core/link/env/test) | **det** | structure + magnitude (**~0.77**) | judgment + voting (~0.55) | det + LLM re-judges only the *uncertain* |
| **wiring** (which core a hunk wires) | **hybrid** | subject anchoring (F1 ~0.63 vs ~0.24) | role-dominated | det + reconcile, LLM **names the seams** & redraws over-wired containers by meaning |

The **default** is `cluster=llm, roles=det, wiring=hybrid` — the LLM where it's the only reliable
engine (grouping/labelling), deterministic where it wins (roles), and deterministic-with-LLM-cleanup
where the deterministic tail over-wires. The load-bearing finding, measured: **grouping is LLM
judgment; wiring is grounding/tracing** (which symbol defined *here* is referenced *there*) — so even
the LLM passes lean on a high-precision deterministic symbol floor ("floor, not ceiling").

**Deterministic passes are a pure function of the change, zero LLM:**

- **roles** — `test`/`environment`/`noise` from structure (paths, imports, type & `.sql` decls,
  `implements` = adapter); **core vs link** from decision-logic density + symbol def↔use *direction*
  (a hunk that **defines** a distinctive symbol others use is the subject → core; a small edit that
  **references** one is wiring → link).
- **wiring** — a non-core hunk wires to every core whose distinctive **subject** it mentions; this
  reaches cores that *modify* existing symbols (the lift from F1 ~0.13 → ~0.63).
- **facts** — roles/wiring read a universal **`HunkFacts`** IR from a **pluggable producer**: `regex`
  (default), **tree-sitter** (`--facts-engine treesitter`: full-file AST), or an **external**
  producer — the VS Code extension's language-server AST facts, fed via `--facts`. Comments/strings
  are masked so keywords inside them don't masquerade as logic.

## Architecture: one engine, many clients

The engine holds **no resident state** — there is **no daemon**; each invocation is independent. The
`--emit-seams` JSON, *not the code*, is the product boundary, so clients evolve independently:

```
            Seam engine (ts/) — stateless; emits the versioned --emit-seams JSON
   ▲             ▲               ▲                ▲                    ▲
 CLI         VS Code ext     MCP server     Claude skill        IntelliJ (planned)
(ts/src/cli) (native render) (mcp/ any LLM) (.claude/skills/seam)
```

- **Contract** — `ts/src/core/contract.ts` stamps `schemaVersion`; the full shape is in
  [`docs/SEAM_JSON_CONTRACT.md`](docs/SEAM_JSON_CONTRACT.md). Additive fields don't bump it; breaking
  changes do, and clients warn on a higher major.
- **Distribution** — run from source (`bun`) or ship the self-contained binary
  (`bun build --compile`). [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) covers both and the
  tree-sitter-grammar caveat.
- **The LLM seam** — `det` runs fully offline. For `hybrid`/`llm`, the engine either spawns a
  subscription-backed CLI (`claude`/`copilot`, no API key) **or** hands its prompts back to a host
  that already has a model, via the host-bus contract (`--emit-prompts` → answer → `--inject-llm`).
  That seam is what lets the `seam` Claude skill and the MCP server **borrow the caller's model**.

## Install & run

The only prerequisite is [**bun**](https://bun.sh) — no Python, no venv, no `node`/`npm`. Install
the deps once, then run from source:

```bash
make install        # bun install in ts/ + vscode-extension/  (one time; the from-source
                    # commands below need ts/'s deps present — this is that step)

# from source, fully offline (det) — works immediately, no model, no API key
bun ts/src/cli/decompose.ts --file sample.patch --classifier det --format ascii
bun ts/src/cli/decompose.ts --git main..HEAD --repo . --classifier det --format ascii
```

**Build the VS Code extension `.vsix` — one command, from a fresh checkout:**

```bash
make vsix           # → vscode-extension/seam-<version>.vsix  (self-contained; bundles the engine)
```

Run bare `make` to list every target. `make ci` runs the full local gate (typecheck + unit tests +
README-command audit + offline smoke over the sample diffs + the `.vsix` build); `make cleanroom`
proves the whole thing installs and runs **from zero inside a vanilla Docker container** — the
"works on a clean machine" check. See [`docs/RELEASE.md`](docs/RELEASE.md) for the release checklist.

You can also build a standalone CLI binary (no checkout / no bun needed to *run* it):

```bash
cd ts && bun run build          # → ts/dist/seam (~100MB)
./ts/dist/seam --file ../sample.patch --classifier det --format ascii
```

The **default (hybrid) uses the LLM for clustering**, so it needs a subscription-backed LLM CLI (no
API key) — prefers the Claude Code `claude` CLI (auto-detected from PATH, `$CLAUDE_BIN`, or the
VS Code extension; override with `--claude-bin`), falling back to the GitHub `copilot` CLI. Roles and
wiring are deterministic and need nothing. For a **fully offline** run, use `--classifier det`
(clusters become structural labels instead of product-intent prose).

### Diff mode

Every command below is copy-pasteable as-is against the checked-in `sample.patch` (CI runs them
verbatim — see [`scripts/readme-audit.sh`](scripts/readme-audit.sh)):

```bash
# fully offline — no LLM at all (works on a bare machine)
bun ts/src/cli/decompose.ts --file sample.patch --classifier det --format ascii

# emit the JSON contract (what every client consumes)
bun ts/src/cli/decompose.ts --file sample.patch --classifier det --emit-seams seams.json

# full-file tree-sitter AST facts on the deterministic passes
bun ts/src/cli/decompose.ts --file sample.patch --classifier det --facts-engine treesitter --format ascii

# default HYBRID: LLM clusters + deterministic roles/wiring  (needs a `claude` CLI)
bun ts/src/cli/decompose.ts --file sample.patch --format ascii
bun ts/src/cli/decompose.ts --git main..HEAD --repo . --format ascii

# mix per pass — deterministic everything except keep LLM wiring  (needs a `claude` CLI)
bun ts/src/cli/decompose.ts --file sample.patch --classifier det --wiring llm --format ascii
```

More varied real-world diffs (small bugfix, multi-file feature, mostly-tests, rename-heavy) are
checked in under [`samples/`](samples/) — see [§Sample diffs](#sample-diffs).

### Codebase mode

```bash
# anchor on a symbol → its intent footprint (consumers + deps), decomposed into seams
bun ts/src/cli/decompose.ts --scan --repo . --classifier det \
    --anchor-file ts/src/core/contract.ts --symbol stampSeamModel --emit-seams footprint.json

# anchor on a whole module (all of a file's exports)
bun ts/src/cli/decompose.ts --scan --repo . --classifier det \
    --anchor-file ts/src/diff/seams.ts --emit-seams footprint.json

# focus the footprint on a natural-language intent  (needs a `claude` CLI)
bun ts/src/cli/decompose.ts --scan --repo . --anchor-file ts/src/diff/seams.ts --symbol emit_seams_json \
    --intent "rate-limit the public API" --emit-seams footprint.json
```

`--depth N` follows N consumer hops; `resolutionQuality` / `unresolved` / `blindspots` in the output
report where static resolution gave out.

**Output formats:** `--format ascii` (terminal), `--format llm` (compact, for an agent), or
`--emit-seams <path>` (the JSON contract). The old HTML report has been removed — clients render the
JSON themselves. Options: per-pass `--cluster/--roles/--wiring llm|det|hybrid`,
`--classifier det|llm|hybrid`, `--facts-engine regex|treesitter`, `--facts <JSON>`,
`--model claude-haiku-4-5`, `--claude-bin <PATH>`, `-v/--verbose`.

### Re-render without the LLM (intermediate state)

The classify pass dumps fully-labelled hunks to JSON — the *intermediate state* between
classification and assembly. Save it once, then iterate downstream with no LLM cost:

```bash
bun ts/src/cli/decompose.ts --file sample.patch --dump-classified samples/sample.classified.json
bun ts/src/cli/decompose.ts --from-classified samples/sample.classified.json --format ascii
```

Ready-made examples are checked in under [`samples/`](samples/) (`sample.classified.json` includes a
shared link wiring two cores, so the many-to-many seam view is visible out of the box).

### Sample diffs

A handful of **real, merged open-source PR diffs** are checked in under [`samples/`](samples/) to
show how the tool behaves on *different shapes* of change — not because they're all flattering, but
so nothing surprises you. `make smoke` decomposes every one of them offline (`--classifier det`):

| sample | source PR | shape | reads as |
|---|---|---|---|
| `requests-cookie-bugfix` | psf/requests#6356 | small focused bugfix | clean — 1 core / 1 link / 1 test |
| `astro-multifile-feature` | withastro/astro#9751 | large multi-file (TS) | one core lifted out of 14 files; rest tests + config |
| `flask-template-filter-feature` | pallets/flask#5736 | feature + wiring | showcase — each new filter lands as a tested seam |
| `httpx-json-compact-tests` | encode/httpx#3367 | **mostly tests** | **0 cores** — see limits below |
| `flask-drop-eol-python-refactor` | pallets/flask#5731 | **rename / deletion-heavy** | **~68% noise** — see limits below |
| `calcom-webhooks` | cal.com | large tangled refactor | 54 hunks → 23 seams / 18 cores |

Try any of them:

```bash
bun ts/src/cli/decompose.ts --file samples/flask-template-filter-feature.patch --classifier det --format ascii
```

The last two **degrade exactly as their shape predicts**, and that's documented honestly in
[§Status & limits](#status--limits) rather than hidden.

## The VS Code extension (primary interactive surface)

The extension ([`vscode-extension/`](vscode-extension/)) consumes `--emit-seams` and renders
**natively** — a per-seam role-coloured **gutter bar** + **scrollbar map** and a **seam tree**
(clusters → seams → hunks), with VS Code itself as the renderer (no HTML stack). It adds
**uncertain-role** markers (`core? uncertain 33%`), **external-coupling** labels (`→ @coss/ui`) with
lazy go-to-definition resolution, **rewire** markers (`↻ showToast → toastManager`), and
**span-aware** focus/nav (each occurrence keyed by `id:start:end`). It drives both modes (review
working changes / a commit; analyze a codebase anchor or module; map/grow an intent footprint) and
feeds the engine **language-server AST facts** via `--facts external`.

Run it: open `vscode-extension/` in VS Code and press **F5** (build with `bun run compile`; uses bun,
not npm).

### What the extension runs (engine modes)

The extension exposes the engine through the **`seam.engine`** setting, and maps it to CLI flags —
plus two enrichments only the editor can provide (the bare CLI on a loose patch gets neither):

| `seam.engine` | flags the extension passes | needs |
|---|---|---|
| **`hybrid`** *(default)* | `--cluster llm --roles det --wiring hybrid` | a `claude` CLI (auto-detected from the Claude Code extension or PATH) |
| **`det`** | `--classifier det` | nothing — fully offline, zero setup |
| **`llm`** | `--classifier llm` | a `claude` CLI |

In **`hybrid`** the LLM does **only** two things — **discovers/labels the clusters** and **names the
seams** (the LLM half of `wiring=hybrid`, on top of a deterministic wiring floor). **Roles
(core/link/environment/test/noise) stay 100% deterministic** — the LLM never classifies a role; only
`llm` mode does. That's why det and hybrid produce identical role counts on the same diff.

On top of those flags, for `det`/`hybrid` the extension feeds the engine the **editor's
language-server AST facts** (`--emit-hunks` → compute defines/enclosing → `--facts <path>`) so the
deterministic roles read a real AST instead of regex, and — when `seam.blastRadius` is on (default) —
resolves each changed symbol's **blast radius** against the live repo (`--blast-radius`, with
`--resolver det|lsp|auto`). So the extension's `hybrid` is *richer* than `--classifier hybrid` on a
standalone patch: same LLM clustering + product-intent labels, but with editor AST facts and
in-repo blast radius that a bare `--file <patch>` run can't supply.

> The default is **`hybrid`** (best quality — needs a subscription-backed `claude` CLI, which the
> Claude Code extension provides). With no `claude` available, switch to **`det`** for a fully offline
> run — Settings → search "Seam" → **Seam: Engine**.

## The MCP server (any LLM can consult Seam)

[`mcp/`](mcp/) exposes Seam to any MCP-capable agent as two tools — `decompose_diff` and
`intent_footprint` — over the same JSON contract. It's a thin stdio adapter over the engine (no
daemon):

- **`engine="det"`** (default) — fully offline, instant; most agents want the *structure* (seams,
  roles, wiring), not prose.
- **`engine="hybrid"/"llm"`** — borrows the **calling client's** model via MCP **sampling**, mapped
  onto the host-bus handshake. No nested `claude -p`, no API key.

```bash
bun mcp/src/server.ts          # stdio MCP server
```

See [`mcp/README.md`](mcp/README.md) for the tool schemas and `.mcp.json` registration.

## The Claude skill (run Seam inside Claude Code)

[`.claude/skills/seam/`](.claude/skills/seam/SKILL.md) bundles Seam as a Claude Code **skill** so you
can decompose **inside a session** with no `claude` binary, no PATH, no API key — the engine's LLM
passes are **served by the running session** via spawned subagents (the host-bus contract again, with
a subagent standing in for the MCP server's sampling). It covers **both** modes:

- **Diff review** — *"review by seam"*, *"decompose this diff"* → emit prompts → subagent per pass →
  inject → render.
- **Codebase intent discovery** — *"where does X live"*, *"map the footprint of X"* → a deterministic
  static footprint, or an LLM-grown one (`--auto`) driven over the interactive `--llm-bridge`.

It auto-triggers on those phrasings, or invoke it explicitly with `/seam`. This is the zero-setup path
when there's no model CLI on PATH; if `claude` *is* available, plain `decompose.ts … --emit-seams`
also works.

## Reliability harness (`ts/eval/`)

The **LLM** classifier is **not deterministic** (the CLI exposes no temperature), so a single run is
meaningless. [`ts/eval/harness.ts`](ts/eval/harness.ts) makes reliability a gate — `generate` caches
N runs per case, `score` computes **stability** (run-to-run agreement) and **accuracy** (vs
`ts/test/gold/`) on the aggregate with tolerance bands:

```bash
bun ts/eval/harness.ts generate --engine det --label det   # deterministic (1 run, no LLM)
bun ts/eval/harness.ts generate --runs 5                    # LLM: each case N times (cached)
bun ts/eval/harness.ts score --label det                    # accuracy vs gold
bun ts/eval/harness.ts score --save ts/eval/baseline.json
bun ts/eval/harness.ts score --baseline ts/eval/baseline.json   # gate: non-zero on regression
```

Accuracy is role accuracy, permutation-invariant **cluster F1**, and wiring as a **seam-granular,
precision-weighted Fβ(0.5)** (a false coupling hurts a reader more than a missing one). The gated
**health** signal is **over-wiring**; *isolated cores / dangling links / orphans are informational
postures, not errors*. The goal is "an acceptable representation," not per-hunk label-match.
Deterministic signals (external coupling, A→B rewire, span segmentation) are pure functions of the
diff and are gated by exact-assertion tests in [`ts/test/`](ts/test/), the right tool for them.

## How it compares — context engines (Augment Code & co.)

Codebase mode puts Seam in the same problem space as a **context engine** like
[Augment Code](https://www.augmentcode.com/context-engine): *give an AI — or a human — the right
cross-cutting slice of a large codebase, beyond grep.* The field has converged on "embeddings alone
aren't enough, you need the dependency graph," and both build one. But the **retrieval substrate is
opposite**:

| | **Augment** context engine | **Seam** codebase mode |
|---|---|---|
| **Retrieval** | custom-trained **vector embeddings** + quantized similarity, with a semantic dependency-graph layer | **deterministic resolved edges** (imports, **data-coupling shared-keys**, HTTP routes, string-dispatch); LLM only to *grow* the footprint + *tier* it |
| **Index** | the whole repo, continuous, **real-time** (100M+ lines) | an **on-demand footprint** from one anchor, per question |
| **Output** | invisible context feeding the model | a **transparent map** — spine, roles, wiring, intent tiers |
| **Confidence** | a similarity score | **provenance** (`RESOLVED` / `PARTIAL` / `SUGGESTED`) + named **blindspots** |
| **Surface** | a full assistant + hosted infra + non-code sources (commits, tickets, docs) | a focused decomposition tool, code-only |

They **converge** on the mission, on building a dependency graph, and on exposing context over
**MCP** (Augment shipped a Context-Engine MCP server in 2026; Seam [already has one](mcp/)).

**Seam-distinct:** an **intent spine** (a ranked, readable main-path answer — not retrieved snippets);
**provenance + blindspots** (it states what it *can't* statically see, where a similarity engine
returns its best match silently); and **cross-framework data-coupling as a first-class edge** — a
`payments` table or `/api/payments` route shared between a backend function and a frontend page. That
last one is the sharpest line: such a link has **no embedding similarity** (the string `payments` in a
SQL call vs a `.tsx` screen aren't semantically close), so a vector engine is weakest exactly where
Seam is strong — and Seam's edge is **verifiable**, not probabilistic.

**Where Seam is behind:** scale (no 100M-line real-time index), learned embeddings, and the non-code
sources. The honest read is **same goal, opposite philosophy** — learned-embedding / always-on /
invisible-plumbing vs deterministic-structural / on-demand / transparent-and-honest — so the two are
arguably **complementary** (both speak MCP), not strictly competing.

## Status & limits

The original *tool vs. discipline* question — does the auto-decomposed presentation deliver the
value, or was the value the mental discipline? — has been **answered in the tool's favour** on real
PRs (you can't mentally hold all the seams), with **friction** (latency, surface polish) as the real
gate, not the concept. Seam is now a product with a stable contract and multiple clients; the open
work is breadth and resolution quality, not whether the idea holds.

Known limits:

- **Role frontier ~0.8.** The core/link boundary is genuinely blurry, and seam wiring quality is
  capped by role accuracy. The interface **surfaces uncertainty** rather than feigning perfection,
  and the wiring pass is high-precision (what it draws is right).
- **Span splitting needs literal symbols.** A big link splits per-core only where it names each
  core's symbol; an informal/aliased coupling stays whole (resolvers locate *genuine* wrappers but
  won't fabricate a link that isn't in the code).
- **Codebase mode is bounded by static resolution.** Cross-language / string-dispatch / DI edges
  surface as `SUGGESTED`/`blindspots` to verify; a headless LSP resolver improves this where a
  language server exists.
- **Test-only PRs have no core to anchor on.** On a change that's almost all tests plus one trivial
  production line (e.g. `samples/httpx-json-compact-tests`), Seam reports **0 cores** and renders a
  single link-only "ambient" seam with the tests grouped to skim — correct, but there's no
  decision-bearing core to structure the review around.
- **Deletion / config-heavy cleanups read thin.** On a rename-and-drop refactor (e.g.
  `samples/flask-drop-eol-python-refactor`), ~**68% of hunks classify as noise** (CI, docs, lockfile,
  `pyproject`) and the surviving seams are mostly link-only config blocks, so the review surface is
  sparse and the one real code core lands with low (~50%) confidence.
- **No GitHub PR ingestion yet**, no line-level roles, no chunking for very large diffs (the
  classifier warns near the context window, `--context-window`, default 200k).
