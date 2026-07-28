// Anchor-relative role assignment — a VIEW over the core's `seam_decompose::assign_roles`.
//
// The four roles (core/link/environment/test) and their confidences are decided in Rust. What used to be
// here was a second implementation of the same rules, and the risk that carries is this layer's whole
// hazard: the pass that ASSIGNS roles and the passes that READ them (clustering, the carrier split, the
// spine) must agree about what a "core" is. Two copies of that definition drift silently — a node demoted
// to environment on one side is simply absent from the other side's answer, with nothing to signal it.
import { type Graph } from "../../core/graph_ir.js";
import { applyNodes, core, toWire } from "./wire.js";

export function assign_roles(g: Graph): void {
  applyNodes(g, core().decomposeAssignRoles(toWire(g)), ["role", "role_confidence"]);
}
