// The decompose graph as the CORE reads it. `seam_decompose` owns the passes now (roles, clusters, the
// carrier split, the crossing split); this module is only the projection between the live TS `Graph` and
// the core's JSON.
//
// NODES CROSS AS AN ARRAY, never an object. A `Map` iterates in insertion order, but `JSON.stringify` of a
// plain object hoists INTEGER-LIKE keys to the front — and group ids (`g1, g2, …`) are numbered by node walk
// order, so a reordering there is a RELABELLING of every cluster in the answer.
//
// Only the fields the passes actually read are sent. That is not a size optimisation: it means a change to
// an unrelated node field cannot silently alter a clustering result.
import { type Graph } from "../../core/graph_ir.js";
import { loadAddon, syncEnv } from "../rust_core.js";

// SYNC THE ENV ON EVERY ACCESS. The carrier split reads three knobs — SEAM_SPLIT, SEAM_HUB_FRAC,
// SEAM_COOC_MERGE — and bun's `process.env` is a JS-side object that Rust's `std::env` never sees. Without
// this, setting SEAM_SPLIT=0 at runtime silently does nothing: the core keeps splitting, the caller believes
// it opted out, and the only symptom is a differently-shaped answer. That exact failure is what caught this.
export const core = () => {
  const a = loadAddon();
  if (!a) throw new Error("the Seam core (Rust addon) is not available — build it with `cargo build --release` in rust/");
  syncEnv(a);
  return a;
};

export const toWire = (g: Graph): string => JSON.stringify({
  nodes: [...g.nodes.values()].map((n) => ({
    id: n.id, label: n.label, file: n.file, kind: n.kind, enclosing: n.enclosing,
    complexity: n.complexity, role: n.role, role_confidence: n.role_confidence,
    group: n.group, intent: n.intent,
  })),
  edges: g.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, provenance: e.provenance, line: e.line ?? 0 })),
  anchor: g.anchor,
  anchors: g.anchors,
});

// Copy the core's per-node verdict back onto the LIVE nodes. Fields are applied one by one rather than by
// wholesale replacement: the TS `Node` carries plenty the core never sees (subcores, contract, hub, entry),
// and a pass that assigns roles must not be able to erase them.
export const applyNodes = (g: Graph, json: string, fields: readonly string[]): void => {
  const parsed = JSON.parse(json);
  if (parsed?.error) throw new Error(`the core rejected the decompose graph: ${parsed.error}`);
  for (const n of parsed.nodes ?? []) {
    const live = g.nodes.get(n.id);
    if (!live) continue;
    for (const f of fields) (live as any)[f] = n[f];
  }
};
