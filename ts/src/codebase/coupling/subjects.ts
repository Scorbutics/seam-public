// THE DATA-COUPLING VOCABULARY, exposed as BEHAVIOUR rather than raw kind Sets. Consumers (the grow loop,
// the seam assembler) ask "is this edge a crossing? this node a flow subject? this a produce-edge?" instead
// of importing the Sets, so coupling's representation stays private to it.
//
// The sets come from the CORE's archetype registry (`couplingVocabulary`), read ONCE and cached here. Read
// once because the callers ask per graph EDGE — tens of thousands per grow — and crossing the napi boundary
// to answer a set-membership question would be paying a syscall for a hash lookup.
//
// Reading them from the core rather than from a TypeScript adapter table is what makes the vocabulary single-
// sourced: the engine that GROUNDS a crossing and the assembler that CLASSIFIES it now agree by construction.
// A new archetype in the core joins these sets by existing.
import { loadAddon } from "../rust_core.js";

const [CROSSING, HANDLER, FLOW_SUBJECT, PRODUCE, DOMAIN_SUBJECT] = (() => {
  const a = loadAddon();
  if (!a) throw new Error("the Seam core (Rust addon) is not available — build it with `cargo build --release` in rust/");
  return (a.couplingVocabulary() as string[][]).map((xs) => new Set(xs));
})();

const KEY_EDGE_KINDS = CROSSING, HANDLER_EDGE_KINDS = HANDLER, KEY_NODE_KINDS = FLOW_SUBJECT;
const KEY_PRODUCE_EDGE_KINDS = PRODUCE, DOMAIN_SUBJECT_KINDS = DOMAIN_SUBJECT;

export const isCouplingCrossing = (edgeKind: string): boolean => KEY_EDGE_KINDS.has(edgeKind);
export const isHandlerEdge = (edgeKind: string): boolean => HANDLER_EDGE_KINDS.has(edgeKind);   // points AT a cross-stack handler endpoint
export const isFlowSubject = (nodeKind: string): boolean => KEY_NODE_KINDS.has(nodeKind);
export const isProduceEdge = (edgeKind: string): boolean => KEY_PRODUCE_EDGE_KINDS.has(edgeKind);
export const isDomainSubject = (nodeKind: string): boolean => DOMAIN_SUBJECT_KINDS.has(nodeKind);
