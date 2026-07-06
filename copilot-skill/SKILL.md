---
name: seam
description: >-
  Use Seam to understand code STRUCTURE across files — how a feature or flow works end to end, where an
  intent lives, who consumes a symbol, a change's blast radius, or how to review a diff by intent. Reach
  for it when the answer is a PATH / FLOW / STRUCTURE spanning multiple files, not a single fact. Run it
  as a CLI (it prints a JSON model you read); this skill says WHEN and HOW. Triggers: "how does X work",
  "where does X live", "map the footprint of X", "what's the blast radius of X", "review this diff/PR by
  intent", "trace this flow across the codebase".
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
Every invocation should write the model with `--emit-seams <file>` and then you read that JSON.

## Pick the call by the shape of the question

| The question | Command | You read |
|---|---|---|
| *"What does this diff/PR do; how do I review it by intent?"* | `seam --git <range> --repo <repo> --emit-seams /tmp/seam.json` (or `--file <patch>`) | clusters → seams + roles + wiring |
| *"Where does this symbol/module live — who consumes it, what does it wire?"* (you have an anchor) | `seam --scan --repo <repo> --anchor-file <f> [--symbol <s>] --intent "<q>" --skeleton --emit-seams /tmp/seam.json` | a static footprint, decomposed into seams |
| *"How does &lt;intent&gt; work / where does it culminate?"* (a question, maybe no symbol) | `seam --scan --auto --repo <repo> --anchor-file <f> --symbol <s> --intent "<q>" --skeleton --emit-seams /tmp/seam.json` | an auto-grown footprint: the anchor's flood-fill region + culmination |
| *who calls X · what X depends on · blast radius · can A reach B · a module boundary · the subsystem around X · how A and B differ* | `seam --scan --query consumers\|dependencies\|impact\|reaches\|contract\|neighborhood\|compare --repo <repo> --anchor-file <f> --symbol <s> [--to-symbol <t>] --emit-seams /tmp/seam.json` | the resolved SET / shape (deterministic, no LLM) |

Then read `/tmp/seam.json` and answer from it. A text report is also available (drop `--emit-seams`), but
the JSON is the reliable contract.

## Reading the JSON

- `clusters[].seams[]` — each seam has `label`, `hunks[]` (with `role`, `file`, line span), and wiring.
- **`relevance` (0..1) and `tier` (spine / supporting / off)** on each grown seam — a **deterministic
  embedding** ranking of how on-intent the seam is (no LLM; reproducible). **Trust the `spine` band; treat
  `off` as background.** `tier` is orthogonal to `role`.
- `blindspots` — statically-opaque edges (cross-language, DI, string dispatch) as `SUGGESTED` leads, never
  asserted facts.
- A broad closure is **normal** — the engine shows everything and ranks; *you* decide what to foreground
  using `tier` (`spine` / `supporting` / `off`). The concern/agent render already orders and dims by it —
  read the spine first and treat the `off` tail as context.

## Routing rules

- **Seam to MAP, grep to DRILL.** Reach for Seam when the answer is a flow / path / structure across
  *multiple files*. For a single-symbol lookup or one-fact answer, grep is instant and Seam is overkill.
- Prefer **one** Seam call over stitching a flow together with many greps.
- **Pass the anchor you already have** as `--symbol` — Seam traces from it instead of re-discovering the
  entry point (faster, and your pick is usually right). Omit it only when you don't know where the flow
  starts.
- **Footprints COMPOSE.** When one ends at a cross-stack blindspot (a shared key/route whose other side
  isn't in the footprint — e.g. backend→frontend), run Seam AGAIN anchored on the **other side** (the key
  as `--intent`, or the consumer file as `--anchor-file`) and stitch — not a manual grep sweep.

## Cross-framework data-coupling (the flywheel)

The deterministic floor already couples DB tables and HTTP routes across the stack. For couplings it has no
built-in adapter for (events/queues/cache/cross-framework keys), Seam can LEARN them with the LLM and then
apply them deterministically — but **learning is a one-time, explicit step**, not part of every query:

- **Warm once per repo:** `seam --scan --repo <repo> --anchor-file <anyfile> --data-coupling llm` (set
  `SEAM_KEY_BUDGET=500` to learn the whole repo in one pass; it caches to `.seam/`). After warming, every
  grow reuses the learned adapters for free and deterministically — across ALL intents (the index is
  repo-wide, content-hash keyed, not per-intent).
- For an ad-hoc query, plain (floor) grow is fine; add `--data-coupling llm` only when the question spans
  frameworks/stacks and the trace left a blindspot.

## If `seam` isn't found

Re-run the installer: `install.sh --skill` (it creates the `seam` command and this skill). The engine
checkout is at `~/.seam` unless `$SEAM_HOME` was overridden.
