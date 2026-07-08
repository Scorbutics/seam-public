---
name: seam
description: >-
  Use Seam to understand code STRUCTURE across files — how a feature or flow works end to end, where an
  intent lives, who consumes a symbol, a change's blast radius, or how to review a diff by intent. Reach
  for it when the answer is a PATH / FLOW / STRUCTURE spanning multiple files, not a single fact. Run it
  as a CLI (it prints a JSON model you read); this skill says WHEN and HOW. Triggers: "how does X work",
  "where does X live", "map the footprint of X", "what's the blast radius of X", "review this diff/PR by
  intent", "trace this flow across the codebase". Run it as a CLI — it prints a compact, ranked intent
  MAP on stdout that you read directly (not a giant JSON blob); this skill says WHEN and HOW.
---

# Seam — route structural questions to the `seam` CLI

Seam decomposes code into **seams** (units of one intent), each part labelled by role
(**core / link / environment / test / noise**) with its wiring, so you review/understand *by intent*
instead of file-by-file.

**Run it as a CLI, not via MCP.** Copilot is unreliable with MCP servers (request timeouts, dropped
tool-call namespaces), so this skill drives the **`seam` command** directly with your shell tool. The CLI
has no host request-deadline and no MCP round-trip — it's faster and reproducible. The engine's own LLM
passes (used by `grow`) are served by your local `copilot`/`claude` binary automatically — no API key, no
MCP sampling.

## The command

Use **`seam`** (installed to `~/.local/bin/seam` by install.sh). If it isn't on `PATH`, run the engine
directly: **`bun ~/.seam/ts/src/cli/decompose.ts`** (the install pins the exact checkout path below).

**Read the map on STDOUT — do NOT dump JSON.** For codebase questions pass **`--format agent`**: a compact,
token-budgeted map (a numbered SPINE + a relevance-ranked region + collapsed blindspots) meant to be read
directly. `--emit-seams <file>` writes the full model as JSON — that is the machine contract for the VS Code
extension, NOT for you: it is often ~40× larger and BURIES the answer. Only use it if you specifically need
a field the map omits.

## Pick the call by the shape of the question

| The question | Command | You read |
|---|---|---|
| *"What does this diff/PR do; how do I review it by intent?"* | `seam --git <range> --repo <repo> --format llm` (or `--file <patch>`) | a markdown summary: clusters → seams + roles |
| *"Where does this symbol/module live — who consumes it, what does it wire?"* | `seam --scan --repo <repo> --center <f>[#<s>] --intent "<q>" --skeleton --format agent` | a compact footprint map |
| *"How does &lt;intent&gt; work / where does it culminate?"* | `seam --scan --auto --repo <repo> --center <f>#<s> --intent "<q>" --skeleton --format agent` (several mechanisms: `--center <f1>#<s1>,<f2>#<s2>`; omit `--center` to let Seam detect them from the intent) | an auto-grown map: spine → culmination |
| *who calls X · what X depends on · blast radius · can A reach B · a module boundary · the subsystem around X · how A and B differ* | `seam --scan --query consumers\|dependencies\|impact\|reaches\|contract\|neighborhood\|compare --repo <repo> --center <f>#<s> [--to-symbol <t>] --format llm-context` | the resolved SET / shape (deterministic, no LLM) |

Read what it prints on stdout. (`--emit-seams <file>` is available for the VS Code extension — a big JSON
model, not for reading in-CLI.)

## Reading the map (`--format agent`)

- **Spine** — the numbered primary path (`anchor → … → outcome`). Read this FIRST; it's the answer's backbone.
- **Region** — the rest, grouped by intent tier (`supporting` / `off`); each line is
  `symbol (file:line) — role — how it's reached`. A broad region is NORMAL — the map already orders and
  dims by relevance, so skim the `off` tail as background rather than treating every line as central.
- **blindspots** — statically-opaque edges (cross-language, DI, string dispatch) surfaced as SUGGESTED leads
  to verify, never asserted facts. When the map ends at one, COMPOSE: re-run from the other side.
- A diff run (`--format llm`) prints clusters → seams + roles instead of a spine; a shape (`--format
  llm-context`) prints the resolved member set. The machine JSON (`--emit-seams`, shape
  `clusters[].seams[].hunks[]` with `role`/`tier`/`relevance`/`blindspots`) is for the extension — parse it
  only if you must read a specific field.

## Routing rules

- **Seam to MAP, grep to DRILL.** Reach for Seam when the answer is a flow / path / structure across
  *multiple files*. For a single-symbol lookup or one-fact answer, grep is instant and Seam is overkill.
- Prefer **one** Seam call over stitching a flow together with many greps.
- **Pass the center you already have** as `--center <f>#<s>` (or several, comma-separated) — Seam traces
  from it instead of re-discovering the entry point (faster, and your pick is usually right). Omit
  `--center` only when you don't know where the flow starts (it detects the mechanism from the intent).
- **Footprints COMPOSE.** When one ends at a cross-stack blindspot (a shared key/route whose other side
  isn't in the footprint — e.g. backend→frontend), run Seam AGAIN anchored on the **other side** (the key
  as `--intent`, or the consumer file as `--center`) and stitch — not a manual grep sweep.

## Cross-framework data-coupling (the flywheel)

The deterministic floor already couples DB tables and HTTP routes across the stack. For couplings it has no
built-in adapter for (events/queues/cache/cross-framework keys), Seam can LEARN them with the LLM and then
apply them deterministically — but **learning is a one-time, explicit step**, not part of every query:

- **Warm once per repo:** `seam --scan --repo <repo> --center <anyfile> --data-coupling llm` (set
  `SEAM_KEY_BUDGET=500` to learn the whole repo in one pass; it caches to `.seam/`). After warming, every
  grow reuses the learned adapters for free and deterministically — across ALL intents (the index is
  repo-wide, content-hash keyed, not per-intent).
- For an ad-hoc query, plain (floor) grow is fine; add `--data-coupling llm` only when the question spans
  frameworks/stacks and the trace left a blindspot.

## If `seam` isn't found

Re-run the installer: `install.sh --skill` (it creates the `seam` command and this skill). The engine
checkout is at `~/.seam` unless `$SEAM_HOME` was overridden.
