// RUST-CORE STRANGLER (Phase 1) — route the deterministic STRUCTURAL grow through the Rust addon
// (rust/seam_core.node) instead of the TS `_growToTerminalsImpl`. Enabled by SEAM_RUST_CORE=1. The addon does the
// intent-free structural grow + coupling (floor + learned-matcher REPLAY); it is byte-identical to the TS grow in
// structural mode (SEAM_GROW_STRUCTURAL), which is the config this path forces. Rendering + flywheel DISCOVERY stay
// in TS for now (later phases move discovery into Rust). The converter maps the addon's GraphDto onto the exact
// ResolvedGraph `data` shape that `from_resolved_graph` consumes.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let _addon: any | undefined; // lazy singleton

function addonPath(): string {
  if (process.env.SEAM_RUST_CORE_PATH) return process.env.SEAM_RUST_CORE_PATH;
  // default: <repo>/rust/seam_core.node, relative to this module (ts/src/codebase/grow/rust_core.ts)
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../rust/seam_core.node");
}

export function rustCoreEnabled(): boolean {
  return process.env.SEAM_RUST_CORE === "1" || process.env.SEAM_RUST_CORE === "true";
}

export function loadAddon(): any {
  if (_addon === undefined) {
    const require = createRequire(import.meta.url);
    _addon = require(addonPath());
  }
  return _addon;
}

// Convert the addon's GraphDto → the TS ResolvedGraph `data`. Fields mirror scan/graph.ts:ResolvedGraph and the
// per-node/edge shapes from_resolved_graph reads (id/symbol/kind/file/range/enclosing/complexity/direction/hub;
// from/to/kind/provenance/line/op). `coupling` is preserved (raw-data consumers read it) though the IR drops it.
function toResolvedGraph(dto: any): any {
  const nodes = (dto.nodes ?? []).map((n: any) => {
    const node: any = {
      id: n.id, symbol: n.symbol, kind: n.kind, file: n.file,
      range: n.range, enclosing: n.enclosing, complexity: n.complexity,
    };
    if (n.coupling) node.coupling = true;
    if (n.direction != null) node.direction = n.direction;
    if (n.hub != null) node.hub = { reason: n.hub.reason, fan: n.hub.fan, sampleConsumers: n.hub.sampleConsumers ?? n.hub.sample_consumers ?? [] };
    return node;
  });
  const edges = (dto.edges ?? []).map((e: any) => {
    const edge: any = { from: e.from, to: e.to, kind: e.kind, provenance: e.provenance };
    if (e.line != null) edge.line = e.line;
    if (e.op != null) edge.op = e.op;
    return edge;
  });
  const blindspots = (dto.blindspots ?? []).map((b: any) => ({
    node: b.node, mechanism: b.mechanism, evidence: b.evidence,
    candidates: b.candidates ?? [], persists: b.persists ?? false,
  }));
  const data: any = {
    version: 1,
    anchor: { id: dto.anchorId ?? dto.anchor_id, symbol: dto.anchorSymbol ?? dto.anchor_symbol, file: dto.anchorFile ?? dto.anchor_file, range: dto.anchorRange ?? dto.anchor_range },
    language: dto.language,
    resolutionQuality: "FULL",
    depth: 1,
    complete: true,
    nodes, edges, blindspots,
    unresolved: dto.unresolved ?? [],
  };
  const anchors = dto.anchors;
  if (anchors && anchors.length) data.anchors = anchors;
  const frontier = dto.frontier;
  if (frontier && frontier.length) data.frontier = frontier;
  return data;
}

// The Rust structural grow. Returns [data, history] matching grow_to_terminals. History is diagnostic-only for
// rendering; flagTruncation "unfollowable" blindspots are synthesized here from the addon's build-failed frontier
// points (cutBy === "build-failed"), preserving the TS truncation-honesty behavior.
export function growViaRust(repo: string, anchorFile: string, symbol: string, opts: any = {}): [any, any[]] {
  const addon = loadAddon();
  const maxSteps = opts.maxSteps ?? 12;
  const maxNodes = opts.maxNodes ?? 80;
  const dataCoupling = opts.dataCoupling !== false;
  const dto = addon.growToTerminals(repo, anchorFile, symbol, dataCoupling, maxSteps, maxNodes);
  const data = toResolvedGraph(dto);
  const history: any[] = [];
  if (opts.flagTruncation) {
    const fps = (dto.frontier ?? []) as any[];
    for (const fp of fps) {
      if (fp.cutBy === "build-failed" || fp.cutBy === "build_failed") {
        history.push({ node: fp.id, added: 0, skipped: "build failed" });
      }
    }
  }
  return [data, history];
}
