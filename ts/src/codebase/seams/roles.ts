// Assign roles to nodes in the graph based on their relationship to anchors and other nodes.
import { type Graph } from "../../core/graph_ir.js";
import { intersect } from "./util.js";

// Confidence scores for the role assignment.
// The model's verdict is blended with the structural facts to produce a final confidence score for each role.
const _CONF_CORE = 1.0, _CONF_TEST = 1.0, _CONF_LINK = 0.9, _CONF_ENV = 0.6;

// The roles are "core", "test", "link", and "environment", with associated confidence scores.
export function assign_roles(g: Graph): void {
  const anchorIds = (g.anchors.length ? g.anchors : [g.anchor]).filter((a) => g.nodes.has(a));
  const anchorSyms = new Set(anchorIds.map((a) => g.nodes.get(a)!.label).filter((s) => s));
  const adj = g.adjacency();
  const core = new Set([...g.nodes.values()].filter((n) =>
    anchorIds.includes(n.id) || (n.enclosing && anchorSyms.has(n.enclosing))).map((n) => n.id));
  const tests = new Set([...g.nodes.values()].filter((n) => n.kind === "test").map((n) => n.id));
  const link = new Set([...g.nodes.keys()].filter((nid) =>
    !core.has(nid) && !tests.has(nid) && intersect(core, adj.get(nid)).size));
  for (const n of g.nodes.values()) {
    if (tests.has(n.id)) { n.role = "test"; n.role_confidence = _CONF_TEST; }
    else if (core.has(n.id)) { n.role = "core"; n.role_confidence = _CONF_CORE; }
    else if (link.has(n.id)) { n.role = "link"; n.role_confidence = _CONF_LINK; }
    else { n.role = "environment"; n.role_confidence = _CONF_ENV; }
  }
}
