# The Seam JSON contract (`--emit-seams`)

This is the **stable boundary every client consumes** — the VS Code extension, the MCP server, and
(later) an IntelliJ plugin. The engine stays a stateless library/binary; clients are thin and talk
to it only through this JSON. Treat the shape here as a product surface, not an internal detail.

- **Source of truth for the version:** [`ts/src/core/contract.ts`](../ts/src/core/contract.ts) →
  `SEAM_SCHEMA_VERSION`, stamped onto every model by `stampSeamModel`.
- **Producer:** `seam … --emit-seams <path>` (diff mode and codebase mode both write this shape).
- **Consumers:** [`vscode-extension/src/extension.ts`](../vscode-extension/src/extension.ts) (mirrors
  these interfaces), the MCP server in [`mcp/`](../mcp), any future plugin.

## Versioning rule

`schemaVersion` is a single integer (major only).

- **Additive optional field → do NOT bump.** Old clients ignore unknown keys; new clients treat the
  field as absent on old output. Most evolution is additive.
- **Removed / renamed field, or a field whose MEANING changes → bump `SEAM_SCHEMA_VERSION`.** Clients
  compare majors: a client built for vN treats `schemaVersion > N` as "I may mis-render — warn the
  user" (the extension does this in `activateModel`), and a missing `schemaVersion` as v1
  (pre-contract output).

Keep this document in lockstep with the constant.

## Top-level model (`SeamModel`)

```jsonc
{
  "schemaVersion": 1,            // stamped by the engine; absent => treat as 1

  // --- always present (both modes) ---
  "clusters": [Cluster],         // intent groups; each holds seams (see below)
  "tests":    [SeamHunk],        // test-role hunks, flat (they cover cores, don't wire them)
  "noise":    [SeamHunk],        // noise-role hunks, flat (skippable churn)

  // --- diff mode, optional ---
  "usage":    Usage,             // tokens/cost — claude backend only; absent for det / host-served runs

  // --- codebase mode, optional (honest-gap fields; diff mode omits them) ---
  "mode": "codebase",
  "anchor": "symbol or module",
  "resolutionQuality": "high|partial|low",   // drives the honesty banner
  "language": "ts|py|…",
  "complete": true,
  "unresolved":   [Unresolved],   // UNKNOWN edges (not "no link") — couldn't be statically resolved
  "blindspots":   [BlindSpot],    // statically-opaque mechanisms (string dispatch, DI, …)
  "seamEdges":    [SeamEdge],     // resolved seam→seam wiring
  "edges":        [GraphEdge],    // raw symbol→symbol call/dependency graph (chain view)
  "seamContracts":[SeamContract], // the symbols bridging each pair of seams
  "selectedSeam": "seam-id|''",   // the seam matching the user's intent (auto-focused)
  "autoGrown":    false,          // an LLM-grown footprint — render ALL seams, don't isolate one
  "skeleton":     true            // OPTIONAL. the LLM seam-intent (tier/label) pass was skipped — seams carry
                                  //   deterministic structure + structural labels only, no `tier`/prose labels.
                                  //   Default for LLM-consumer / structure-only output (`--format llm-context|waves|
                                  //   scenarios`); a renderer should treat every seam as equally lit.
}
```

## `Cluster` — one technical/product intent

```jsonc
{ "id": "c0", "intent": "human prose or a structural label", "colorIndex": 0,
  "seams": [Seam],
  "subgroups": [ { "label": "…", "seamIds": ["s1","s2"] } ]   // optional: structural zoom on big clusters
}
```

## `Seam` — one unit of review (≥1 core + its wiring)

```jsonc
{ "id": "s0", "label": "…", "linkOnly": false, "uncertain": false,
  "warnings": ["dangling", …],   // posture kinds (informational — NOT errors); see seams.ts _verify_pair
  "hunks": [SeamHunk],
  "suggested": false,            // codebase mode: a SUGGESTED (unverified) seam, never a resolved edge

  // --- codebase mode, optional ---
  "primary":   { "file": "…", "line": N, "symbol": "…" },  // the seam's representative ("this is where it lives")
  "tier":      "spine|supporting|off",  // intent relevance band — ABSENT under `skeleton` (no LLM tiering pass)
  "region":    { "shell": N, "direction": "up|down|both|" }, // flood-fill shape: hop distance from the anchor +
                                        //   the direction it was reached (↑ consumers / ↓ deps). The REGION,
                                        //   WAVE (group by `shell`) and SCENARIO (forward-graph over `edges`)
                                        //   views are built purely from `region` + `edges` — no LLM.
  "culmination": 0.0             // 0..1 confidence this seam is where the flow's outcome is produced
}
```

## `SeamHunk` — one hunk occurrence in a seam

A hunk can appear in several seams (a link wires more than one core). Occurrence identity is
`(id, start, end)`, not `id` alone.

```jsonc
{ "id": "h3", "file": "src/api.ts", "start": 10, "end": 24,
  "role": "core|link|environment|test|noise",   // the PRIMARY read — drives the editor colour
  "confidence": 0.8,            // role self-consistency vote share; < 0.6 => surfaced as "maybe"
  "label": "…", "relevant": true,

  // wiring / boundary signals (all optional)
  "external":    ["@coss/ui"],                          // couples to a symbol from a module outside the change
  "externalRefs":[ { "symbol": "x", "source": "@coss/ui" } ],
  "rewire":      { "removed": ["showToast"], "added": ["toastManager"] } | null,  // a focused A→B swap
  "suggested":   true,                                  // THIS membership is a low-confidence wire (dim) — the hunk
                                                        //   appears in this seam, but its link to it is an unverified
                                                        //   guess, not a confirmed coupling. Absent => confident.
  "suggestedWires": ["h7"],                             // (hunk-level) every seam id this hunk wires only as a guess;
                                                        //   `suggested` above is just `seamId ∈ suggestedWires`, localised
  "consumers":   [ { "file": "…", "symbol": "…", "status": "resolved|suggested" } ], // blast radius (diff mode, --blast-radius)

  // proposed sub-structure (rendered with a distinct "proposal" affordance, never as verified)
  "subcores":  [ { "id":"…","label":"…","ranges":[[s,e]],"reads":["…"],"proposed":true } ],
  "contract":  [ { "name":"…","role":"…","ranges":[[s,e]],"invoked":true,
                   "feeds":[ {"from":"…","value":"…","line":N,"valLine":N,"valCol":N} ] } ],

  // codebase mode provenance
  "provenance": "RESOLVED_FULL|RESOLVED_PARTIAL|SUGGESTED|…",
  "caller": true,

  // COLLAPSED HUB (codebase mode, --hub-collapse / SEAM_HUB_COLLAPSE). OPTIONAL, present only on a hub node.
  // A ubiquitous type/util (a `MyString` reached from everywhere) is kept as ONE node with a handle instead of
  // its off-intent consumer fan being flooded across the codebase (I3: collapse, never silently drop). Fully
  // deterministic — reason + counts come from the ubiquity/fan indices, never a semantic judgement.
  "hub": { "reason": "ubiquity|fan|type", "fan": N, "sampleConsumers": ["path/a.ts", "path/b.ts"] }
}
```

## Auxiliary codebase-mode types

```jsonc
Usage         { "calls", "input_tokens", "output_tokens", "total_tokens", "cost_usd", "duration_ms", "backends":[…] }
Unresolved    { "node", "query", "reason" }
BlindSpot     { "node", "mechanism", "evidence", "candidates":[ { "symbol", "provenance" } ] }
SeamEdge      { "from", "to", "provenance" }
GraphEdge     { "from", "to", "kind", "provenance", "line"? }   // line = call-site in `from`'s file
SeamContract  { "seamA", "seamB", "links":[GraphEdge], "blurry" }
```

## Notes for client authors

- **Roles top out ~0.8 accuracy** (the core/link frontier is genuinely blurry). Render
  `confidence < 0.6` as a "maybe", never as a fact. The tool structures; the human judges.
- **Postures are not errors.** `linkOnly`, `dangling`, `isolated`, `orphan` are legitimate review
  states — surface them as neutral information, not warnings to fix.
- **SUGGESTED ≠ resolved.** Anything tagged `suggested` / `SUGGESTED` is an unverified guess for a
  statically-opaque mechanism — render it as "go verify", never as an asserted edge.
- **Wiring is encoded by membership; `suggested` grades it.** A non-core hunk wires to a seam by
  appearing in that seam's `hunks` (a hunk wiring several seams is duplicated across them — dedupe by
  `id`). On each membership, `suggested: true` marks a low-confidence (dim) wire vs a confident one;
  this is the diff-mode mirror of the codebase-mode seam-level `suggested`. An LLM consumer should
  read confident memberships as couplings and `suggested` ones as "verify".
