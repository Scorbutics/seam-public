// THE DATA-COUPLING VOCABULARY, exposed as BEHAVIOUR rather than raw kind Sets. Consumers (the grow loop,
// the seam assembler) ask "is this edge a crossing? this node a flow subject? this a produce-edge?" instead
// of importing the Sets, so coupling's representation stays private to it.
//
// These live APART from the coupling ENGINE (index.ts) deliberately: they are the only part of the TypeScript
// coupling layer the rest of the engine still calls — the floor, the ground, the flywheel and the apply
// stage are the core's (`seam-couple`). Splitting them out is what lets index.ts go without dragging the
// grow and the seam assembler with it. The kind sets are still DERIVED from the adapter registry, so a new
// adapter extends the vocabulary without editing this file.
import { KEY_EDGE_KINDS, HANDLER_EDGE_KINDS, KEY_NODE_KINDS, KEY_PRODUCE_EDGE_KINDS, DOMAIN_SUBJECT_KINDS } from "./adapters/index.js";

export const isCouplingCrossing = (edgeKind: string): boolean => KEY_EDGE_KINDS.has(edgeKind);
export const isHandlerEdge = (edgeKind: string): boolean => HANDLER_EDGE_KINDS.has(edgeKind);   // points AT a cross-stack handler endpoint
export const isFlowSubject = (nodeKind: string): boolean => KEY_NODE_KINDS.has(nodeKind);
export const isProduceEdge = (edgeKind: string): boolean => KEY_PRODUCE_EDGE_KINDS.has(edgeKind);
export const isDomainSubject = (nodeKind: string): boolean => DOMAIN_SUBJECT_KINDS.has(nodeKind);
