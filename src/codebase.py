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

import os
import re
from collections import Counter
from pathlib import Path

from . import atoms as atoms_mod
from . import graph_ir
from .graph_ir import (BlindSpot, Edge, Graph, Provenance, connected_components,
                       undirected_adjacency, wellformedness)

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
    """Layer 4 (clusters): connectivity partition over the resolved graph (call edges +
    containment). The cluster `intent` is the anchor symbol for the anchor's own cluster,
    else the highest-complexity core's symbol. Seam grain WITHIN a cluster is decided by
    `assign_seams` (cohesion), not here."""
    order = g.order()
    edges = [(e.src, e.dst) for e in g.resolved_edges()] + _containment_edges(g)
    groups = connected_components(order, edges)

    members: dict[str, list[str]] = {}
    for nid in order:
        g.nodes[nid].group = groups[nid]
        members.setdefault(groups[nid], []).append(nid)

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


def assign_seams(g: Graph) -> None:
    """Layer 4 (seam grain): group each cluster's cores into intent SEAMS by COHESION,
    cutting where cohesion DROPS — the boundary algorithm the brief puts at the heart of
    seam quality (not the LLM).

    Two cores are cohesive when they call each other OR share a NON-AMBIENT collaborator
    (a link/environment node both touch). 'Ambient' = a collaborator touched by more than
    half the cluster's cores — a shared base type / util that is NOT what any one seam is
    about (the cal.com `<Button>` hairball lesson, carried over from the diff engine). The
    connected components of that cohesion graph are the seams:
      - tightly-coupled methods (charge + refund both using the gateway) → ONE seam;
      - a method off on its own (a DI-wired `validate` with no resolved collaborator) → its
        OWN singleton seam, which then surfaces honestly as an isolated-core.
    A core sharing only an AMBIENT collaborator stays a separate seam, so that collaborator
    attaches to BOTH seams (the legitimate many-to-many) instead of fusing them.

    NB (epistemic status): distance-to-anchor WEIGHTING and the collapse/surface ALTITUDE
    rule (plan §3 Layer 4) are the FLAGGED refinements — not built here. This cohesion floor
    is deterministic and offline-tested; the altitude question is for the manual-validation
    protocol (§5).
    """
    adj = undirected_adjacency(g.resolved_edges())
    cores_by_cluster: dict[str, list[str]] = {}
    for n in g.nodes.values():
        if n.role == "core":
            cores_by_cluster.setdefault(n.group, []).append(n.id)

    anchor_sym = g.nodes[g.anchor].label if g.anchor in g.nodes else ""
    for cluster_cores in cores_by_cluster.values():
        core_set = set(cluster_cores)
        cut = max(2, len(cluster_cores) // 2)        # ambient if touched by MORE than this
        # which cores touch each non-core collaborator (the cohesion carrier)
        by_collab: dict[str, list[str]] = {}
        cohesion: list[tuple[str, str]] = []
        for c in cluster_cores:
            for nb in adj.get(c, set()):
                if nb in core_set:
                    cohesion.append((c, nb))         # direct core→core call
                else:
                    by_collab.setdefault(nb, []).append(c)
        for cs in by_collab.values():
            if len(cs) <= cut:                       # non-ambient shared collaborator
                cohesion += [(cs[0], x) for x in cs[1:]]
        seam_of = connected_components(cluster_cores, cohesion)
        # representative per seam group + label (anchor symbol wins; else top complexity)
        members: dict[str, list[str]] = {}
        for cid in cluster_cores:
            members.setdefault(seam_of[cid], []).append(cid)
        for ids in members.values():
            rep = (g.anchor if g.anchor in ids else
                   max(ids, key=lambda i: g.nodes[i].complexity))
            label = anchor_sym if g.anchor in ids else g.nodes[rep].label
            for cid in ids:
                g.nodes[cid].seam = g.nodes[rep].id
                g.nodes[cid].seam_label = label


# --------------------------------------------------------------------------- Layer 2: blind spots
_DYNAMIC_IMPORT_RE = re.compile(r"""import\(\s*['"]([^'"]+)['"]\s*\)""")
_SCAN_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
_SKIP_DIRS = frozenset({"node_modules", ".git", "dist", "build", ".next", "out",
                        ".turbo", "coverage", ".cache", "vendor"})
_BLINDSPOT_CAP = 50


def detect_dynamic_import_blindspots(g: Graph, repo: str) -> None:
    """Layer 2 (presence detection, plan §2): find consumers that load the anchor via a
    STRING-PATH dynamic import — `dynamic(() => import("…/Anchor"))`, `await import("…/Anchor")`.

    The symbol reference provider CANNOT see these: a module path is not a symbol reference,
    so find-references reports the anchor as used-nowhere — a FALSE isolated-core, the
    'map that lies with confidence' failure. We detect the MECHANISM deterministically (a
    text scan, DÉT) and surface each site as a SUGGESTED coupling in the blind-spot overlay —
    NEVER a resolved edge (invariant §1). High-recall by basename, hence unverified/SUGGESTED
    (a path match can hit a namesake or a comment).

    Lives in Python (not the TS resolver) so it is offline-testable and also works headless via
    `decompose.py --graph --repo`; it could move into the resolver front later.
    """
    if not g.anchor or g.anchor not in g.nodes or not repo:
        return
    anchor_file = g.nodes[g.anchor].file
    stem = Path(anchor_file).name.rsplit(".", 1)[0] if anchor_file else ""
    if not stem:
        return
    anchor_abs = os.path.normpath(os.path.join(repo, anchor_file))
    candidates: list[Edge] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_SCAN_EXT):
                continue
            fpath = os.path.join(root, fn)
            if os.path.normpath(fpath) == anchor_abs:
                continue                                  # the anchor's own file
            try:
                text = Path(fpath).read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if "import(" not in text or stem not in text:
                continue                                  # fast reject before the regex
            for i, line in enumerate(text.splitlines(), 1):
                if "import(" not in line:
                    continue
                for m in _DYNAMIC_IMPORT_RE.finditer(line):
                    path = m.group(1)
                    if path.rsplit("/", 1)[-1].rsplit(".", 1)[0] == stem:
                        rel = os.path.relpath(fpath, repo)
                        candidates.append(Edge(src=g.anchor, dst=f"{rel}:{i}",
                                               kind="dynamic-import", provenance=Provenance.SUGGESTED))
            if len(candidates) >= _BLINDSPOT_CAP:
                break
        if len(candidates) >= _BLINDSPOT_CAP:
            break
    if candidates:
        g.blindspots.append(BlindSpot(
            node=g.anchor, mechanism="dynamic-import",
            evidence=(f"loaded via dynamic import in {len(candidates)} place(s) — a string-path "
                      "load the reference resolver can't see"),
            candidates=candidates))


# --------------------------------------------------------------------------- Model B: sub-cores
def detect_subcores(g: Graph, repo: str) -> None:
    """Model B (plan `seam-B-…`): propose a behavioural decomposition of the ANCHOR core into
    sub-cores, when the anchor is a function/component (not a class — a class is already
    decomposed into method cores). The atoms (boundaries) are RESOLVED; the GROUPING is PROPOSED.

    Atoms = the anchor's nested function-like units (handlers/callbacks). They group by COHESION
    over shared NON-AMBIENT identifiers (the same ambient filter as seams: a name in > half the
    atoms is shared glue — `setIsOpen`, `router` — and does NOT fuse; a distinctive shared name
    does). The grouping is a SUGGESTED partition: it can mis-frame, never fabricate a coupling.
    Collapses to the single core (no split) on < 2 atoms or a single cohesion group.
    """
    if not g.anchor or g.anchor not in g.nodes:
        return
    node = g.nodes[g.anchor]
    anchor_sym = node.label
    # a CLASS is already decomposed into method cores — don't also sub-core it.
    if any(n.enclosing == anchor_sym for n in g.nodes.values() if n.id != g.anchor):
        return
    lang = atoms_mod.lang_for(node.file)
    if not lang:
        return
    try:
        content = Path(os.path.join(repo, node.file)).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return
    atoms = atoms_mod.extract_atoms(content, lang, node.start, node.end)
    if len(atoms) < 2:
        return                                              # nothing to decompose → core stays whole (A)

    # cohesion grouping over the atoms (same ambient discipline as assign_seams)
    cut = max(1, len(atoms) // 2)
    freq = Counter(name for a in atoms for name in a.names)  # # atoms each name appears in
    ambient = {name for name, c in freq.items() if c > cut}
    ids = [f"{g.anchor}.b{i}" for i in range(len(atoms))]
    by_name: dict[str, list[str]] = {}
    edges: list[tuple[str, str]] = []
    for i, a in enumerate(atoms):
        for name in a.names:
            if name not in ambient:
                by_name.setdefault(name, []).append(ids[i])
    for members in by_name.values():
        edges += [(members[0], x) for x in members[1:]]
    groups = connected_components(ids, edges)
    if len(set(groups.values())) < 2:
        return                                              # uniform cohesion → one behaviour → A

    by_group: dict[str, list[int]] = {}
    for i in range(len(atoms)):
        by_group.setdefault(groups[ids[i]], []).append(i)
    subcores = []
    for gid, idxs in sorted(by_group.items()):
        ranges = [[atoms[i].start, atoms[i].end] for i in idxs]
        reads = sorted({n for i in idxs for n in atoms[i].names if n not in ambient})
        subcores.append({"id": gid, "label": reads[0] if reads else gid,
                         "ranges": ranges, "reads": reads, "proposed": True})
    node.subcores = subcores


def detect_contract(g: Graph, repo: str) -> None:
    """Model A (plan §A): decompose the ANCHOR core's CONTRACT (its params/props) — the finer
    altitude of the usage edge ("X uses me" → "X feeds me prop P, used at line L"), which is
    where a single-core component finally carries information. A member INVOKED in the body is a
    behavioural LINK (a threaded callback, e.g. `onDelete`); a read-only member is ENVIRONMENT
    (passive data, e.g. `open`/`isDeleting`). RESOLVED — params + intra-scope uses are
    deterministic. Skips a class anchor (its methods are the decomposition). The consumer-feed
    (which arg the caller passes to each prop) is the best-effort layer A2, not built here."""
    if not g.anchor or g.anchor not in g.nodes:
        return
    node = g.nodes[g.anchor]
    if any(n.enclosing == node.label for n in g.nodes.values() if n.id != g.anchor):
        return                                              # a class — already method-decomposed
    lang = atoms_mod.lang_for(node.file)
    if not lang:
        return
    try:
        content = Path(os.path.join(repo, node.file)).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return
    members = atoms_mod.extract_contract(content, lang, node.start, node.end)
    node.contract = [{"name": m.name, "role": "link" if m.invoked else "environment",
                      "ranges": [list(r) for r in m.ranges], "invoked": m.invoked} for m in members]


def detect_consumer_feeds(g: Graph, repo: str) -> None:
    """Model A2: complete each contract member's thread with WHO FEEDS IT — at every consumer of
    the anchor, the value passed to that prop (consumer → prop → internal use). The consumers are
    already the resolved usage links; we parse each one's `<Anchor …/>` usage for the per-prop
    bindings (RESOLVED — a real binding; the value's own definition is a further step). Mutates
    the existing `node.contract` entries with a `feeds: [{from, value, line}]` list."""
    if not g.anchor or g.anchor not in g.nodes:
        return
    node = g.nodes[g.anchor]
    by_name = {c["name"]: c for c in node.contract}
    if not by_name:
        return
    anchor_name = node.label
    consumers = {e.src for e in g.edges if e.dst == g.anchor}    # who references the anchor
    seen: set[str] = set()
    for cid in consumers:
        cn = g.nodes.get(cid)
        if cn is None or not cn.file or cn.file in seen:
            continue
        seen.add(cn.file)
        lang = atoms_mod.lang_for(cn.file)
        if not lang:
            continue
        try:
            content = Path(os.path.join(repo, cn.file)).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for pname, binds in atoms_mod.extract_consumer_feeds(content, lang, anchor_name).items():
            member = by_name.get(pname)
            if member is None:
                continue
            for b in binds:
                feed = {"from": cn.file, "value": b["value"], "line": b["line"]}
                if "valLine" in b:                          # the value's position, for A3 def resolution
                    feed["valLine"], feed["valCol"] = b["valLine"], b["valCol"]
                member.setdefault("feeds", []).append(feed)


def decompose(g: Graph, repo: str | None = None) -> dict:
    """Run the codebase layers in order (roles → clusters → seams → Layer-2 blind spots →
    Model-B sub-cores → Model-A contract → well-formedness) and return the SeamModel. `g` is
    mutated. When `repo` is given, scan for statically-opaque couplings (dynamic imports), propose
    a behavioural sub-core decomposition, and decompose the anchor's contract into prop-links."""
    assign_roles(g)
    assign_clusters(g)
    assign_seams(g)
    if repo:
        detect_dynamic_import_blindspots(g, repo)
        detect_subcores(g, repo)
        detect_contract(g, repo)
        detect_consumer_feeds(g, repo)          # A2: complete each prop thread with its feeders
    health = wellformedness(g)
    return emit_seams(g, health)


# --------------------------------------------------------------------------- emit (SeamModel)
def _seam_hunk(n: graph_ir.Node, provenance: str) -> dict:
    """A node rendered as a SeamHunk (the extension's per-line decoration unit). Mirrors the
    diff `emit_seams_json` shape so the native renderer is unchanged; `provenance` is the
    new per-edge-honesty field (diff-mode hunks are implicitly HEUR). A core may also carry
    `subcores` — a PROPOSED behavioural partition (Model B), additive and clearly flagged."""
    out = {"id": n.id, "file": n.file, "start": n.start, "end": n.end,
           "role": n.role, "confidence": round(n.role_confidence, 2),
           "label": n.label, "provenance": provenance,
           "external": [], "externalRefs": [], "rewire": None}
    if n.subcores:
        out["subcores"] = n.subcores
    if n.contract:
        out["contract"] = n.contract
    return out


def emit_seams(g: Graph, health: dict) -> dict:
    """Assemble the SeamModel (clusters → seams → hunks) from the decomposed graph.

    A seam = a core + the links/environment nodes directly wired to it (many-to-many: a
    link adjacent to two cores appears in both seams, like diff-mode). Warnings come from
    Layer 6. `tests` and the honest-gap overlays (`unresolved`, `blindspots`) are surfaced
    top-level; `resolutionQuality` rides along so the extension can show the honesty banner.
    """
    adj = undirected_adjacency(g.resolved_edges())
    edge_prov = {(e.src, e.dst): e.provenance.value for e in g.resolved_edges()}

    def prov_to_group(nid: str, core_ids: set[str]) -> str:
        for c in core_ids:
            p = edge_prov.get((nid, c)) or edge_prov.get((c, nid))
            if p:
                return p
        return "RESOLVED_FULL"

    seam_warnings = health.get("seam_warnings", {})
    node_warnings = health.get("node_warnings", {})
    by_file_line = lambda n: (n.file, n.start)

    # every non-test node belongs to a cluster (a core-less cluster is a legitimate
    # link-only/rewire view); tests are surfaced separately (skim posture).
    by_cluster: dict[str, list[graph_ir.Node]] = {}
    for n in g.nodes.values():
        if n.role != "test":
            by_cluster.setdefault(n.group, []).append(n)

    clusters = []
    for ci, (gid, nodes) in enumerate(sorted(by_cluster.items())):
        cores = [n for n in nodes if n.role == "core"]
        # group cores into SEAMS by the seam id `assign_seams` set (cohesion).
        seam_groups: dict[str, list[graph_ir.Node]] = {}
        for c in cores:
            seam_groups.setdefault(c.seam or c.id, []).append(c)
        attached: set[str] = set()
        seams = []
        for seam_id, gc in sorted(seam_groups.items()):
            gc.sort(key=by_file_line)
            core_ids = {c.id for c in gc}
            # non-core neighbours of ANY core in the seam (within this cluster), deduped.
            # A collaborator shared with cores in ANOTHER seam attaches to both (many-to-many).
            att = sorted({nid for c in gc for nid in adj.get(c.id, set())
                          if g.nodes[nid].role in ("link", "environment") and g.nodes[nid].group == gid},
                         key=lambda x: by_file_line(g.nodes[x]))
            attached.update(att)
            hunks = [_seam_hunk(c, "RESOLVED_FULL") for c in gc]
            hunks += [_seam_hunk(g.nodes[nid], prov_to_group(nid, core_ids)) for nid in att]
            warns: list[str] = []
            for c in gc:
                warns += [w for w in seam_warnings.get(c.id, []) if w not in warns]
            for nid in att:
                warns += [w for w in node_warnings.get(nid, []) if w not in warns]
            seams.append({"id": seam_id, "label": gc[0].seam_label or seam_id,
                          "linkOnly": False, "uncertain": any(c.role_confidence < 0.6 for c in gc),
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
