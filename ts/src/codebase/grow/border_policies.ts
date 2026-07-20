// BORDER POLICIES — the deterministic containment rules the wave loop in orchestrate.ts consults per
// candidate move (hub/ubiquity classification today; tier-grow/up-hop/soft-intent-border are still inline
// in orchestrate.ts — extracting those needs the same treatment, done incrementally rather than in one
// risky pass over the wavefront's shared per-wave state). Each policy is a pure function of explicit
// per-wave facts (never a closure over the whole grow), so it's independently testable.
import type { HubMarker } from "../../core/graph_ir.js";
import { isFlowSubject } from "../coupling/index.js";
import { ubiquityOf } from "./ubiquity.js";

export type HubClassification = { reason: HubMarker["reason"]; fan: number } | null;
export type HubClassifier = (n: { id: string; kind: string; file: string; symbol?: string; coupling?: unknown }) => HubClassification;

// HUB CLASSIFICATION (I4-safe) — ONE deterministic test serving the ubiquity gate AND hub-collapse. A node
// that BEARS a grounded crossing / is a flow-subject / is a coupling node is NEVER a hub (it's on the spine).
// Otherwise: ubiquity fan-in ≥ threshold → a shared-infra hub; under collapse, a type-ref-only node with a
// lower fan-in → the `MyString` shape. Returns the marker (reason + fan) or null.
//
// I4 REFINEMENT — the DATA-SINK exception. A coupling-revealed node that is a shared DATA SINK (a JPA @Entity)
// is the one crossing-bearer whose UP-consumer fan must still be contained: following the table crossing IS
// spine-ward (kept — the node and its down/crossing edges are untouched), but its consumers are every
// DAO/query/mapper in the app — the whole data layer, not this flow. Import-based `ubiquityOf` misses it
// (in-package Java refs aren't imports), so it is deduced structurally via `opts.dataHub` (the @Entity set,
// supplied by the caller). Without this, a coupling-revealed entity floods a large-Java-repo flow (Keycloak
// UserEntity ↑up = +3303 off-flow consumers). Scoped to `n.coupling` nodes so a structurally-reached entity is
// unchanged. Governed by SEAM_COUPLING_HUB_CONTAIN at the call site (an empty dataHub set = a no-op here).
export function makeHubClassifier(opts: {
  ubiquity: boolean;
  crossingBearers: Set<string>;
  hubCollapse: boolean;
  hubUbiquity: number;
  ubiquityFan: number;
  typeRefOnly: Set<string>;
  hubTypeFan: number;
  ubiqScore: unknown;
  dataHub?: (n: { symbol?: string; file: string }) => boolean;
}): HubClassifier {
  return (n) => {
    if (!opts.ubiquity) return null;
    const dataSink = !!n.coupling && (opts.dataHub?.(n) ?? false);   // a coupling-revealed @Entity: contain its up-fan
    if (!dataSink && (opts.crossingBearers.has(n.id) || isFlowSubject(n.kind) || n.coupling)) return null;
    const u = ubiquityOf(opts.ubiqScore as any, n.file);
    if (dataSink) return { reason: "ubiquity", fan: Math.max(u, opts.hubUbiquity) };
    if (u >= (opts.hubCollapse ? opts.hubUbiquity : opts.ubiquityFan)) return { reason: "ubiquity", fan: u };
    if (opts.hubCollapse && opts.typeRefOnly.has(n.id) && u >= opts.hubTypeFan) return { reason: "type", fan: u };
    return null;
  };
}
