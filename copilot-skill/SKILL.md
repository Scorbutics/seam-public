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

**Run it as a CLI.** That is how Seam is driven: this skill invokes the **`seam` command** directly with
your shell tool. There is no host request-deadline and no tool-call round-trip, so a run is faster and
reproducible. The engine's own LLM passes (used by `grow`) are served by your local `copilot`/`claude`
binary automatically — no API key needed.

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
| *"How is &lt;X&gt; MANAGED / handled across the app?"* (a STAR — one mechanism, many entry points) | **pick the center FIRST (see below), then** `seam --scan --auto --concern --repo <repo> --center <f>#<s> --intent "<q>" --skeleton --format concern` | a center-first map: In (entry ──HTTP/db──▶ ●) / Out (● ──writes──▶ db) |
| *"How does &lt;X&gt; FLOW / where does it culminate?"* (a LINE — trace one path) | **pick the center FIRST, then** `seam --scan --auto --repo <repo> --center <f>#<s> --intent "<q>" --skeleton --format agent` (several: `--center <f1>#<s1>,<f2>#<s2>`) | an auto-grown spine → culmination |
| *who calls X · what X depends on · blast radius · can A reach B · a module boundary · the subsystem around X · how A and B differ* | `seam --scan --query consumers\|dependencies\|impact\|reaches\|contract\|neighborhood\|compare --repo <repo> --center <f>#<s> [--to-symbol <t>] --format llm-context` | the resolved SET / shape (deterministic, no LLM) |
| *"what does this module export, how do I call it, and how do callers actually use it?"* | `seam --scan --query contract --repo <repo> --center <file> --format llm-context` | per export: its DECLARED signature + OBSERVED call sites (count + argument-count histogram) + its consumers |

**`--query contract` replaces the grep-for-the-signature step.** For each export it prints the declared parameter
list and return type — resolved through a wrapper, so `export const f = withReporting(_impl)` reports `_impl`'s
signature — plus what the real call sites do: how many there are and how many arguments each passes. Where the two
disagree is the actionable part: a declared parameter no caller passes is safe to narrow, and an export with
consumers but ZERO call sites is imported for its type or re-exported, never invoked. Observed counts are matched
by callee NAME, so read the `## Gaps` section before trusting a total.

Read what it prints on stdout. (`--emit-seams <file>` is available for the VS Code extension — a big JSON
model, not for reading in-CLI.)

## ALWAYS pick the center yourself — do NOT omit `--center`

For a footprint or a grow, **you choose the mechanism, then Seam traces from it.** This is a mandatory
first step — never run the grow with only `--intent` and let the engine guess:

1. **Find the mechanism symbol(s)** for the intent — one quick search. Look for the class/service/handler
   named after the domain noun in the question. E.g. for *"how are bookings managed"*:
   ```bash
   rg -il 'booking' --type java        # → BookingService.java, BookingsController.java, …
   ```
   Pick the 1–3 that actually implement the behaviour (a `*Service` / `*Manager` / `*Controller` /
   `*Handler`), not tests or DTOs.

2. **Pass them as `--center`** — `--center "path/BookingService.java#manage"`, or the whole class
   `--center "path/BookingService.java"`, or several comma-separated
   `--center "path/BookingService.java,path/BookingsController.java"`.

**Why:** YOU understand the question better than the engine's fallback text-matcher. Passing the center is
faster (no extra center-pick LLM pass), more accurate (you avoid it guessing a ubiquitous or sibling node),
and deterministic. Omit `--center` ONLY if, after searching, you genuinely cannot find any candidate symbol
— and say so explicitly. Do not default to omitting it.

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
- **ALWAYS pass `--center`** (see the section above): grep for the mechanism symbol(s), then
  `--center <f>#<s>` (or several, comma-separated). Don't run a grow on `--intent` alone — picking the
  center yourself is faster, more accurate, and deterministic. No-`--center` is a last resort, not the default.
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
