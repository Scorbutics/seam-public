// SCAN phase — the ResolvedGraph type contract (the same shape the VS Code resolver emits) plus the
// public footprint-builder surface. These types make explicit what the builders previously passed around
// as `any`. coupling/ emits CouplingNode/Crossing/Blindspot (coupling/types.ts) which are STRUCTURALLY
// assignable to GraphNode/GraphEdge/Blindspot here — we deliberately do NOT cross-import (coupling is the
// DAG leaf and must not depend on scan), so the shapes are kept compatible by hand, not by a shared type.
import type { EngineCtx } from "../engine_ctx.js";
import type { Provenance } from "../../core/resolution.js";

// A named def found in a file: [name, kind, startLine, endLine]. The unit of enclosing-symbol attribution.
export type Unit = [name: string, kind: string, start: number, end: number];

// Resolution provenance — how confident an edge is. THE one ladder, defined in core/resolution and
// shared with call-graph dispatch + import resolution; re-exported here for the scan graph's consumers.
export type { Provenance };

// A node in the footprint graph — the anchor, a consumer/dependency, or a coupling boundary/complement.
export interface GraphNode {
  id: string;
  symbol: string;
  kind: string;            // node kind ("function"/"class"/"method"/"module"/a coupling boundary label)
  file: string;
  range: number[];         // [startLine, endLine]
  enclosing: string;       // the owning class/module symbol, or ""
  complexity: number;
  coupling?: true;         // a data-flow (key/route) node, not a call/import node
  direction?: "forward" | "backward";   // tagged on a bidirectional footprint
  entry?: boolean;         // a framework/external entry point (set by decompose)
}

// An edge wiring two nodes. `line` is the call/usage line on the consumer side, when known.
export interface GraphEdge {
  from: string;
  to: string;
  kind: string;            // "reference"/"call"/"import"/"contains"/a coupling crossing label
  provenance: Provenance;
  line?: number;
}

// A coupling/edge the engine SEES but won't draw as a resolved edge (an unresolved import, an ambiguous
// dispatch, an external lib, an ungrounded LLM proposal) — surfaced for review. Mirrors coupling.Blindspot.
export interface Blindspot {
  node: string;
  mechanism: string;
  evidence: string;
  candidates: any[];       // shape varies by mechanism (string[] of class names, {file,symbol,provenance}, …)
  persists?: boolean;      // (interface-multiple-impls) an impl grounds a db-store write → a DI wall hiding a persist
}

// A query the engine couldn't resolve statically — a lead for the LSP/extension layer to follow.
export interface Unresolved { node: string; query: string; reason: string }

// The footprint contract. `anchors` accumulates as a grow expands; `resolvedMethods` is an internal
// hand-off from build_callsite_graph (stripped before it reaches a merged graph / oracle).
export interface ResolvedGraph {
  version: 1;
  anchor: { id: string; symbol: string; file: string; range: number[] };
  anchors?: string[];
  language: string;
  resolutionQuality: "FULL";
  depth: number;
  complete: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  blindspots: Blindspot[];
  unresolved: Unresolved[];
  resolvedMethods?: string[];
}

// Which way the footprint grows from the anchor: UP = consumers (where it's used), DOWN = dependencies
// (what it delegates to / how it works), BOTH = a direction-tagged merge of the two.
export type Direction = "up" | "down" | "both";

// The full option surface of build_footprint — a superset of every builder's options, documented in one
// place. Not every option applies to every direction (`useLlm` is dependency-only, `verified`/`depth`
// feed the consumers path); the dispatcher routes the relevant subset.
export interface FootprintOpts {
  direction?: Direction;                 // default "up"; a null symbol routes to the module footprint
  depth?: number;                        // consumers: include the depth-2 environment ripple when >= 2
  anchorLine?: number | null;
  verified?: any;                        // consumers/class: LSP-verified method usage from the extension
  useLlm?: boolean;                      // dependency: tier-3 LLM coupling discovery
  dataCoupling?: boolean;                // shared-key boundary overlay (default on)
  dataCouplingLlm?: boolean;             // use the LLM key front-end for the overlay
  skipCallsite?: boolean;                // skip the uncached receiver-agnostic call-site walk (blast-radius counts)
  callerFiles?: string[];                // dependency/class: files that REACHED this type anchor — restricts its
                                         // DOWN methods to the ones those callers actually invoke (walk de-noise).
                                         // Absent (seed / direct query) → ALL methods (the full class decomposition).
  ctx?: EngineCtx;
  model?: string;
  claudeBin?: string | null;
}

// Build the canonical ResolvedGraph envelope — collapses the return literal the builders each repeated.
export function makeGraph(
  anchor: ResolvedGraph["anchor"],
  language: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: { depth?: number; complete?: boolean; blindspots?: Blindspot[]; unresolved?: Unresolved[]; anchors?: string[] } = {},
): ResolvedGraph {
  const g: ResolvedGraph = {
    version: 1,
    anchor,
    language: language ?? "",
    resolutionQuality: "FULL",
    depth: opts.depth ?? 1,
    complete: opts.complete ?? true,
    nodes,
    edges,
    blindspots: opts.blindspots ?? [],
    unresolved: opts.unresolved ?? [],
  };
  if (opts.anchors) g.anchors = opts.anchors;
  return g;
}
