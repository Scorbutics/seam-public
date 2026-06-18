---
name: seam
description: >-
  Use Seam to understand code STRUCTURE across files — how a feature or flow works end to end, where an
  intent lives, who consumes a symbol, a change's blast radius, or how to review a diff by intent. Reach
  for it when the answer is a PATH / FLOW / STRUCTURE spanning multiple files, not a single fact. Seam
  is available as MCP tools (decompose_diff, intent_footprint, grow_intent); this skill says WHEN to
  call them. Triggers: "how does X work", "where does X live", "map the footprint of X", "what's the
  blast radius of X", "review this diff/PR by intent", "trace this flow across the codebase".
---

# Seam — route structural questions to the MCP tools

Seam decomposes code into **seams** (units of one intent), each part labelled by role
(**core / link / environment / test / noise**) with its wiring, so you review/understand *by intent*
instead of file-by-file. It runs as an **MCP server** — you **call its tools**, you do not run an
engine yourself. Pick the tool by the shape of the question:

| The question | Tool | What it returns |
|---|---|---|
| *"What does this diff/PR do, and how do I review it by intent?"* | **`decompose_diff`** | the change grouped into seams + roles + wiring (offline by default) |
| *"Where does this symbol/module live — who consumes it, what does it wire?"* (you have an anchor) | **`intent_footprint`** | a static footprint from the anchor, decomposed into seams |
| *"How does &lt;intent&gt; work / where does it culminate?"* (you have a question, maybe not a symbol) | **`grow_intent`** | an LLM-grown footprint toward the intent: anchor → spine → culmination |

## Routing rules

- **Seam to MAP, grep to DRILL.** Reach for Seam when the answer is a flow / path / structure across
  *multiple files*. For a single-symbol lookup, find-usages, or any one-fact answer, use grep or your
  editor — it is instant and Seam is overkill.
- Prefer **one** Seam call over stitching a flow together with many greps.
- **Pass the anchor you already have.** If you've already located a candidate symbol, pass it as
  `symbol` to `intent_footprint` / `grow_intent` — Seam then traces from it instead of re-discovering
  the entry point (faster, and your pick is usually right). Omit it only when you genuinely don't know
  where the flow starts.
- Seam is **honest about gaps.** Statically-opaque edges (cross-language, DI, string dispatch) come
  back as `SUGGESTED` / `blindspots` — treat those as leads to verify, never as asserted facts.
- **Footprints COMPOSE.** When a footprint ends at a *cross-stack blindspot* (a shared key / route whose
  other side isn't in the footprint — e.g. a backend→frontend data flow), the right next move is to call
  the Seam tool AGAIN anchored on the **other side** (the unresolved key as the `intent`, or the consumer
  file as the anchor) and stitch the two footprints together — **not** a manual grep sweep over the UI.
- **`crossFramework` is opt-in.** `intent_footprint` / `grow_intent` take a `crossFramework` flag that
  enables LLM cross-framework coupling. The default (deterministic) floor already couples DB tables and
  HTTP routes (annotation handlers ⇄ `fetch`/`$http`) across the stack — so set `crossFramework: true`
  ONLY when a question spans frameworks/stacks and the deterministic trace left a blindspot. It costs an
  extra LLM pass per step, so prefer the re-anchor-and-compose move first.
- **Engine cost.** `decompose_diff` and `intent_footprint` default to offline (`engine="det"`, no LLM).
  `grow_intent` is LLM-driven — those passes are served by the local `copilot` binary through the
  registered server (no API key, no MCP sampling needed).

If the Seam tools aren't listed, the MCP server isn't registered — install it with
`install.sh --mcp` (it registers `seam` with the Copilot CLI automatically).
