"""Codebase-mode decomposition — the anchor-relative front (plan §3, layers 3-4-6).

Diff-mode and codebase-mode SHARE the GraphIR barebone (`graph_ir`: the IR, the
Layer-4 partition op, the Layer-6 well-formedness op) but FORK their assignment —
the two products have opposite epistemics (plan §1.1 / §2). This module is the
codebase fork: roles are assigned by an **anchor-relative BFS over the RESOLVED
graph**, not by the diff `HunkFacts` ladder. It NEVER finds an edge — every edge
was already resolved by the `SymbolResolver` front and ingested via
`graph_ir.from_resolved_graph`. The LLM does not enter here (it labels intent in a
later layer, on the built seams — constraint §5).

ROLES, relative to the anchor (plan Layer 3):
  - core        — the anchor symbol itself + the members it encloses (its internals).
  - link        — a node OUTSIDE the anchor directly wired to a core: the joint that
                  connects the anchor to the system (A needs only B's contract).
  - environment — reached but not a direct joint: shared/ambient ripple.
  - test        — a verification node (covers cores; not a peer role).
There is NO `noise` role: noise is a diff artifact (renames/formatting); a static
view has none.

EPISTEMIC STATUS (be honest — plan §6): roles + well-formedness + provenance are
DÉT and complete-by-construction over the resolved graph. The SEAM GRAIN here is a
v0 floor — one seam per core, links attached to adjacent cores, clusters by
connectivity. Distance-weighted community detection (Leiden/Louvain, the real
Layer-4 altitude rule) is FLAGGED THEORY and deliberately NOT built yet; this floor
is what lets the manual-validation protocol (§5) and the wow test (§6) run first.
"""
from __future__ import annotations

from . import graph_ir
from .graph_ir import Graph, connected_components, undirected_adjacency, wellformedness

# Role confidence == how structural the call is. Core/test are structural facts; link is a
# resolved adjacency to a core; environment is the residual (lowest, surfaces as soft).
_CONF_CORE = 1.0
_CONF_TEST = 1.0
_CONF_LINK = 0.9
_CONF_ENV = 0.6


def assign_roles(g: Graph) -> None:
    """Layer 3: anchor-relative roles over the RESOLVED adjacency. Mutates `g.nodes`."""
    anchor_sym = g.nodes[g.anchor].label if g.anchor in g.nodes else ""
    adj = undirected_adjacency(g.resolved_edges())

    core = {n.id for n in g.nodes.values()
            if n.id == g.anchor or (anchor_sym and n.enclosing == anchor_sym)}
    tests = {n.id for n in g.nodes.values() if n.kind == "test"}
    link = {nid for nid in g.nodes
            if nid not in core and nid not in tests and (adj.get(nid, set()) & core)}

    for n in g.nodes.values():
        if n.id in tests:
            n.role, n.role_confidence = "test", _CONF_TEST
        elif n.id in core:
            n.role, n.role_confidence = "core", _CONF_CORE
        elif n.id in link:
            n.role, n.role_confidence = "link", _CONF_LINK
        else:
            n.role, n.role_confidence = "environment", _CONF_ENV


def _containment_edges(g: Graph) -> list[tuple[str, str]]:
    """A node↔its-enclosing-symbol edge, derived from the RESOLVED `enclosing` fact already
    on each node (the resolver's documentSymbol tree). Containment is a resolved structural
    fact, so it legitimately joins an anchor's members to the anchor in the partition —
    without it the class node and its methods, lacking a call edge, would split apart."""
    label_to_id = {n.label: n.id for n in g.nodes.values() if n.label}
    return [(n.id, label_to_id[n.enclosing])
            for n in g.nodes.values() if n.enclosing in label_to_id]


def assign_clusters(g: Graph) -> None:
    """Layer 4 (v0 floor): connectivity partition over the resolved graph (call edges +
    containment) + one seam per core. A core anchors a seam (`seam` id = node id); the
    cluster `intent` is the anchor symbol for the anchor's own cluster, else the
    highest-complexity core's symbol."""
    order = g.order()
    edges = [(e.src, e.dst) for e in g.resolved_edges()] + _containment_edges(g)
    groups = connected_components(order, edges)

    members: dict[str, list[str]] = {}
    for nid in order:
        g.nodes[nid].group = groups[nid]
        members.setdefault(groups[nid], []).append(nid)

    for n in g.nodes.values():
        if n.role == "core":
            n.seam, n.seam_label = n.id, n.label

    anchor_sym = g.nodes[g.anchor].label if g.anchor in g.nodes else ""
    for gid, ids in members.items():
        cores = [g.nodes[i] for i in ids if g.nodes[i].role == "core"]
        if g.anchor in ids and anchor_sym:
            intent = anchor_sym
        elif cores:
            intent = max(cores, key=lambda c: c.complexity).label
        else:
            intent = g.nodes[ids[0]].label or gid
        for i in ids:
            g.nodes[i].intent = intent


def decompose(g: Graph) -> dict:
    """Run the codebase layers in order (roles → clusters → well-formedness) and return the
    SeamModel the extension renders. `g` is mutated with the assignment."""
    assign_roles(g)
    assign_clusters(g)
    health = wellformedness(g)
    return emit_seams(g, health)


# --------------------------------------------------------------------------- emit (SeamModel)
def _seam_hunk(n: graph_ir.Node, provenance: str) -> dict:
    """A node rendered as a SeamHunk (the extension's per-line decoration unit). Mirrors the
    diff `emit_seams_json` shape so the native renderer is unchanged; `provenance` is the
    new per-edge-honesty field (diff-mode hunks are implicitly HEUR)."""
    return {"id": n.id, "file": n.file, "start": n.start, "end": n.end,
            "role": n.role, "confidence": round(n.role_confidence, 2),
            "label": n.label, "provenance": provenance,
            "external": [], "externalRefs": [], "rewire": None}


def emit_seams(g: Graph, health: dict) -> dict:
    """Assemble the SeamModel (clusters → seams → hunks) from the decomposed graph.

    A seam = a core + the links/environment nodes directly wired to it (many-to-many: a
    link adjacent to two cores appears in both seams, like diff-mode). Warnings come from
    Layer 6. `tests` and the honest-gap overlays (`unresolved`, `blindspots`) are surfaced
    top-level; `resolutionQuality` rides along so the extension can show the honesty banner.
    """
    adj = undirected_adjacency(g.resolved_edges())
    edge_prov = {(e.src, e.dst): e.provenance.value for e in g.resolved_edges()}

    def prov_of(a: str, b: str) -> str:
        return edge_prov.get((a, b)) or edge_prov.get((b, a)) or "RESOLVED_FULL"

    seam_warnings = health.get("seam_warnings", {})
    node_warnings = health.get("node_warnings", {})

    # every non-test node belongs to a cluster (a core-less cluster is a legitimate
    # link-only/rewire view); tests are surfaced separately (skim posture).
    by_cluster: dict[str, list[graph_ir.Node]] = {}
    for n in g.nodes.values():
        if n.role != "test":
            by_cluster.setdefault(n.group, []).append(n)

    clusters = []
    for ci, (gid, nodes) in enumerate(sorted(by_cluster.items())):
        cores = sorted((n for n in nodes if n.role == "core"), key=lambda c: c.id)
        attached: set[str] = set()
        seams = []
        for c in cores:
            att = sorted((nid for nid in adj.get(c.id, set())
                          if g.nodes[nid].role in ("link", "environment") and g.nodes[nid].group == gid),
                         key=lambda x: (g.nodes[x].file, g.nodes[x].start))
            attached.update(att)
            hunks = [_seam_hunk(c, "RESOLVED_FULL")]
            hunks += [_seam_hunk(g.nodes[nid], prov_of(c.id, nid)) for nid in att]
            warns = list(seam_warnings.get(c.id, []))
            for nid in att:
                warns += [w for w in node_warnings.get(nid, []) if w not in warns]
            seams.append({"id": c.id, "label": c.seam_label or c.id,
                          "linkOnly": False, "uncertain": c.role_confidence < 0.6,
                          "warnings": warns, "hunks": hunks})
        # ambient ripple: reached nodes wired to no core in this cluster (depth-2 env, dangling
        # links). Surfaced as ONE neutral seam so nothing resolved is silently dropped.
        leftover = sorted((n for n in nodes if n.role != "core" and n.id not in attached),
                          key=lambda n: (n.file, n.start))
        if leftover:
            warns: list[str] = []
            for n in leftover:
                warns += [w for w in node_warnings.get(n.id, []) if w not in warns]
            seams.append({"id": f"{gid}-ambient", "label": "ambient ripple",
                          "linkOnly": not cores, "uncertain": False, "warnings": warns,
                          "hunks": [_seam_hunk(n, "RESOLVED_FULL") for n in leftover]})
        clusters.append({"id": gid, "intent": (cores[0].intent if cores else nodes[0].intent),
                         "colorIndex": ci, "seams": seams})

    tests = [_seam_hunk(n, "RESOLVED_FULL") for n in g.nodes.values() if n.role == "test"]
    return {
        "clusters": clusters,
        "tests": tests,
        "noise": [],
        # codebase-mode additions (extension reads additively; diff-mode omits them):
        "mode": "codebase",
        "anchor": g.anchor,
        "resolutionQuality": g.resolution_quality,
        "language": g.language,
        "complete": g.complete,
        "blindspots": [{"node": b.node, "mechanism": b.mechanism, "evidence": b.evidence,
                        "candidates": [{"symbol": c.dst, "provenance": c.provenance.value}
                                       for c in b.candidates]} for b in g.blindspots],
        "unresolved": g.unresolved,
        "health": health.get("postures", {}),
    }
