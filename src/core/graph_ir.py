"""GraphIR — the mode-agnostic graph the decomposition layers operate on.

This is the SHARED BARÈBONE (plan §1.1 / decision D6). Two *fronts* produce a
`Graph`:

  - diff-mode:     labeled hunks → `from_hunks()`  (this file)
  - codebase-mode: an anchor + `SymbolResolver` → a resolved neighborhood (future)

…and the *same* graph operations (clustering / community detection = Layer 4,
well-formedness = Layer 6) run on the result. The layers MUST NOT know which front
produced the graph: no hunk field, no `vscode` type, no `if mode == …` branch may
appear here. That import-boundary IS the loose-coupling contract (plan R5).

What is deliberately NOT here: ROLE / WIRING ASSIGNMENT. Those fork by mode (the
diff `HunkFacts` ladder in `classifier_det`; an anchor-relative BFS for codebase),
because the two products have opposite epistemics (plan §2). Both write their result
into the SAME `Node.role` / `Edge` slots, so everything downstream stays identical.

THE CARRYING INVARIANT (plan §1). Every edge carries a `provenance`. Only RESOLVED
edges may bear the completeness promise. `SUGGESTED` / `LLM` / `HEUR` edges are NOT
completeness-bearing and must never enter the resolved adjacency a Layer-4/6 op
treats as exhaustive. `assert_resolved_only()` is that guard, materialized as code:
it is a hard error — never a warning — if a non-resolved edge reaches the resolved
set. Derived rule: a missing edge means "unknown", not "no link" — `Graph.unresolved`
records what the resolver could not answer so an empty adjacency is never mistaken
for a real isolated node (the "map that lies with confidence" failure).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Provenance(str, Enum):
    """Where an edge came from — the only axis the completeness promise reads.

    `RESOLVED_*` come from deterministic, verifiable symbol resolution and COUNT for
    completeness-by-construction. The rest are interpretive overlays and NEVER count.
    Ordered most→least authoritative.
    """
    RESOLVED_FULL = "RESOLVED_FULL"        # precise resolver, language quality FULL
    RESOLVED_PARTIAL = "RESOLVED_PARTIAL"  # resolver answered, language quality PARTIAL
    HEUR = "HEUR"                          # heuristic (e.g. diff symbol-anchoring)
    SUGGESTED = "SUGGESTED"                # candidate target for a blind spot (Layer 2b)
    LLM = "LLM"                            # drawn by a model

    @property
    def is_resolved(self) -> bool:
        return self in (Provenance.RESOLVED_FULL, Provenance.RESOLVED_PARTIAL)


# The edge provenances that bear the completeness promise (plan §1).
RESOLVED = frozenset({Provenance.RESOLVED_FULL, Provenance.RESOLVED_PARTIAL})


@dataclass
class Node:
    """A unit of decomposition, relative to nothing until a front assigns a role.

    Mode-agnostic: a diff hunk OR a resolved code symbol. Identity (`id`) is the only
    field the graph ops require; the rest carry the labels a front fills in and the
    back (SeamModel emit) reads. Line range is new-side / file-absolute when known.
    """
    id: str
    label: str = ""                 # human name: a symbol, or a hunk's primary subject
    file: str = ""
    start: int = 0                  # file line, inclusive (0 = unknown)
    end: int = 0
    kind: str = ""                  # symbol kind (codebase) / change_type (diff)
    enclosing: str = ""             # the symbol this node lives inside (its class/scope)
    complexity: int = 0             # "aboutness" magnitude — decisions (diff) / nesting (codebase)
    # filled by the (mode-specific) assignment passes:
    role: str = ""                  # core | link | environment | test | noise | ""
    role_confidence: float = 1.0
    relevant: bool = True           # mark-relevance: is this wiring ON the answer path (vs incidental,
                                    # reached-but-not-part-of-the-answer)? Default True; the LLM pass
                                    # only marks links False so the UI DIMS them — never drops (honest).
    group: str = ""                 # cluster id (Layer 4 output)
    intent: str = ""                # cluster label
    seam: str = ""                  # for a core: the seam id it anchors
    seam_label: str = ""
    # Model B: a PROPOSED partition of this core into behavioural sub-cores (codebase mode).
    # The atoms/ranges inside are RESOLVED (real code regions); the GROUPING is a proposal —
    # a suggested reading over verified atoms, which can mis-frame but cannot fabricate a
    # coupling. Empty unless the codebase Layer-B pass ran. Each item:
    #   {id, label, ranges: [[start,end],…], reads: [name,…], proposed: true}
    subcores: list = field(default_factory=list)
    # Model A: this core's CONTRACT decomposed into its params/props — the finer altitude of the
    # usage edge. A member INVOKED in the body is a behavioural link (a threaded callback); a
    # read-only member is environment (passive data). All RESOLVED. Each item:
    #   {name, role: "link"|"environment", ranges: [[start,end],…], invoked: bool}
    contract: list = field(default_factory=list)


@dataclass
class Edge:
    """A directed dependency `src → dst` with its provenance (the §1 spine).

    `kind` is the resolved relation (call / import / implements / fieldRef / defines)
    in codebase-mode, or "wires" in diff-mode. The graph ops are kind-agnostic for
    clustering (an edge is an edge); only completeness reads `provenance`.
    """
    src: str
    dst: str
    kind: str = "wires"
    provenance: Provenance = Provenance.HEUR
    line: int = 0                   # 0-based CALL-SITE line in src's file (where src invokes dst), when
                                    # known — so the chain/contract can jump to the usage, not just the def


@dataclass
class BlindSpot:
    """Layer 2: a statically-opaque mechanism (DI / reflection / events / string
    dispatch) detected by PRESENCE (deterministic), with optional SUGGESTED targets.
    Lives apart from `Graph.edges` — its candidates are never resolved adjacency."""
    node: str
    mechanism: str
    evidence: str = ""
    candidates: list[Edge] = field(default_factory=list)   # provenance == SUGGESTED


@dataclass
class Graph:
    """The shared IR. `edges` holds resolved/heuristic adjacency; `blindspots` and
    `unresolved` are the honest-gap overlays kept strictly OUT of `edges`."""
    nodes: dict[str, Node] = field(default_factory=dict)
    edges: list[Edge] = field(default_factory=list)
    # codebase-mode metadata (unused by diff-mode; documents the contract — plan §2.1):
    anchor: str = ""                # the PRIMARY anchor (the seed)
    anchors: list[str] = field(default_factory=list)  # expansion lineage (P2): all cores' anchors
    language: str = ""
    resolution_quality: str = ""    # FULL | PARTIAL | HEURISTIC | NONE (probed, plan §4)
    depth: int = 0                  # BFS depth resolved to (anchor-bounded, plan D5)
    complete: bool = True           # False ⇒ frontier truncated at `depth`
    blindspots: list[BlindSpot] = field(default_factory=list)
    unresolved: list[dict] = field(default_factory=list)  # UNKNOWN ≠ [] (plan §1 derived rule)

    def order(self) -> list[str]:
        """Stable node id order — the basis for deterministic component numbering."""
        return list(self.nodes.keys())

    def resolved_edges(self) -> list[Edge]:
        return [e for e in self.edges if e.provenance.is_resolved]


# --------------------------------------------------------------------------- invariant guard
class ResolvedOnlyViolation(AssertionError):
    """A non-RESOLVED edge reached the resolved adjacency (plan §1 / constraint §7.1)."""


def assert_resolved_only(edges: list[Edge]) -> None:
    """Hard gate run BEFORE any completeness-bearing op (Layer 4/6 over the resolved
    graph). Raising — not warning — is the point: if a SUGGESTED/LLM/HEUR edge is
    being treated as resolved, the completeness promise is already broken (plan §1)."""
    bad = [e for e in edges if not e.provenance.is_resolved]
    if bad:
        sample = ", ".join(f"{e.src}->{e.dst}({e.provenance.value})" for e in bad[:5])
        raise ResolvedOnlyViolation(
            f"{len(bad)} non-resolved edge(s) in the resolved adjacency: {sample}")


# --------------------------------------------------------------------------- union-find
class _DSU:
    def __init__(self, ids: list[str]):
        self.parent = {i: i for i in ids}

    def find(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


# --------------------------------------------------------------------------- Layer 4: clustering
def connected_components(nodes: list[str], edges: list[tuple[str, str]]) -> dict[str, str]:
    """Partition nodes into clusters by connectivity — the mode-agnostic core of Layer 4.

    Group ids are `g1, g2, …` numbered by first-encounter of each component's root in
    `nodes` order (so isolated nodes each form their own singleton component → orphans).
    An edge endpoint not in `nodes` is ignored. Union is `union(src, dst)`, applied in
    `edges` order; this exactly reproduces the diff engine's historical numbering so the
    refactor is behaviour-preserving. (Distance-weighted community detection — Leiden/
    Louvain for codebase-mode — is a richer op layered on the same Graph; this connected-
    components floor is what diff-mode needs and what both modes share today.)
    """
    present = set(nodes)
    dsu = _DSU(nodes)
    for a, b in edges:
        if a in present and b in present:
            dsu.union(a, b)
    root_to_group: dict[str, str] = {}
    out: dict[str, str] = {}
    for n in nodes:
        r = dsu.find(n)
        out[n] = root_to_group.setdefault(r, f"g{len(root_to_group) + 1}")
    return out


# --------------------------------------------------------------------------- diff-mode front (adapter)
def from_hunks(hunks, provenance: Provenance = Provenance.HEUR) -> Graph:
    """Project labeled diff hunks into the shared `Graph` — diff-mode's FRONT.

    Proves the diff pipeline's implicit graph maps losslessly onto the IR. Nodes = hunks;
    edges are of two kinds, both stamped with `provenance` (HEUR for the det engine, LLM
    for the model-drawn hybrid edges — the diff product makes NO completeness promise, so
    these are correctly non-resolved):
      - "wires": each non-core hunk's dependency on a core/seam;
      - "seam":  co-membership among the cores of one multi-core seam — the grouping
        `merge_seams` adds beyond pure wiring (same file + enclosing component). Without
        it a merged-but-unwired core would split off when the partition is recomputed, so
        it is part of the diff graph, not decoration.
    Role / seam / group / intent are carried verbatim from the already-run passes.
    """
    g = Graph()
    for h in hunks:
        g.nodes[h.id] = Node(
            id=h.id, label=(h.seam_label or h.intent or ""), file=h.file_path,
            kind=h.change_type, role=h.role or "", role_confidence=h.role_confidence,
            group=h.group, intent=h.intent, seam=h.seam, seam_label=h.seam_label,
        )
    present = set(g.nodes)
    for h in hunks:
        resolved = set(getattr(h, "resolved_wires", ()) or ())
        for t in (h.wires or []):
            if t in present:
                # A wire drawn from a REAL resolved import is RESOLVED_FULL (the codebase confirms
                # it); the rest stay `provenance` (HEUR/LLM — the diff makes no completeness promise).
                prov = Provenance.RESOLVED_FULL if t in resolved else provenance
                g.edges.append(Edge(src=h.id, dst=t, kind="wires", provenance=prov))
    # seam co-membership: chain the cores sharing a seam id so the recomputed partition
    # matches the engine's group (which folds merge_seams' same-component grouping in).
    seam_cores: dict[str, list[str]] = {}
    for h in hunks:
        if (h.role or "") == "core" and h.seam:
            seam_cores.setdefault(h.seam, []).append(h.id)
    for ids in seam_cores.values():
        for prev, cur in zip(ids, ids[1:]):
            g.edges.append(Edge(src=prev, dst=cur, kind="seam", provenance=provenance))
    return g


# --------------------------------------------------------------------------- codebase front (adapter)
def _provenance_for_quality(quality: str) -> Provenance:
    """Default edge provenance when the resolver didn't stamp one, derived from the probed
    language quality (plan §4). FULL → RESOLVED_FULL; PARTIAL → RESOLVED_PARTIAL. A graph
    whose quality is HEURISTIC/NONE must NOT mint resolved edges — callers stamp those
    explicitly; here we conservatively downgrade to RESOLVED_PARTIAL so completeness is
    never over-claimed (constraint §7.2)."""
    return Provenance.RESOLVED_FULL if quality.upper() == "FULL" else Provenance.RESOLVED_PARTIAL


def from_resolved_graph(data: dict) -> Graph:
    """Ingest the `ResolvedGraph` JSON the `SymbolResolver` front emits (plan §2.1) — the
    codebase-mode FRONT. This is the ONLY place the resolver contract is parsed; nothing
    here knows it came from VSCode (constraint §4 — the API never leaks past the JSON).

    Edges in `edges[]` are RESOLVED (they bear the completeness promise). `blindspots`
    (SUGGESTED candidates) and `unresolved` (UNKNOWN ≠ []) are carried into their OWN
    fields, never into `edges` — the §1 invariant materialized at ingestion.
    """
    g = Graph()
    g.language = data.get("language", "")
    g.resolution_quality = data.get("resolutionQuality", "")
    g.depth = int(data.get("depth", 0) or 0)
    g.complete = bool(data.get("complete", True))
    default_prov = _provenance_for_quality(g.resolution_quality)

    for nd in data.get("nodes", []):
        rng = nd.get("range") or [0, 0]
        g.nodes[nd["id"]] = Node(
            id=nd["id"], label=nd.get("symbol", nd["id"]), file=nd.get("file", ""),
            start=int(rng[0]) if rng else 0, end=int(rng[1]) if len(rng) > 1 else 0,
            kind=nd.get("kind", ""), enclosing=nd.get("enclosing", ""),
            complexity=int(nd.get("complexity", 0) or 0),
        )
    present = set(g.nodes)
    for ed in data.get("edges", []):
        src, dst = ed.get("from"), ed.get("to")
        if src not in present or dst not in present:
            continue                 # an endpoint outside the resolved neighborhood
        prov = Provenance(ed["provenance"]) if ed.get("provenance") else default_prov
        g.edges.append(Edge(src=src, dst=dst, kind=ed.get("kind", "call"), provenance=prov,
                            line=int(ed.get("line", 0) or 0)))

    # anchor: the node BFS started from. The contract carries its id; fall back to matching
    # symbol+file so a resolver that omits the id still resolves it.
    a = data.get("anchor") or {}
    g.anchor = a.get("id", "")
    if g.anchor not in present and a.get("symbol"):
        g.anchor = next((n.id for n in g.nodes.values()
                         if n.label == a["symbol"] and (not a.get("file") or n.file == a["file"])), "")
    # P2: the expansion lineage — every anchor whose footprint was merged in (roles are computed
    # relative to ALL of them). Falls back to the single primary anchor for an un-expanded scan.
    g.anchors = [aid for aid in data.get("anchors", []) if aid in present] or ([g.anchor] if g.anchor in present else [])

    for bs in data.get("blindspots", []):
        cands = [Edge(src=bs["node"], dst=c.get("symbol", ""), kind="blindspot",
                      provenance=Provenance.SUGGESTED) for c in bs.get("candidates", [])]
        g.blindspots.append(BlindSpot(node=bs["node"], mechanism=bs.get("mechanism", ""),
                                      evidence=bs.get("evidence", ""), candidates=cands))
    g.unresolved = list(data.get("unresolved", []))
    return g


# --------------------------------------------------------------------------- Layer 6: well-formedness
def undirected_adjacency(edges: list[Edge]) -> dict[str, set[str]]:
    """Symmetric adjacency over the given edges — the substrate for role BFS and
    well-formedness. Callers pass `g.resolved_edges()` when completeness matters."""
    adj: dict[str, set[str]] = {}
    for e in edges:
        adj.setdefault(e.src, set()).add(e.dst)
        adj.setdefault(e.dst, set()).add(e.src)
    return adj


def wellformedness(g: Graph) -> dict:
    """Layer 6 — the blind-spot map, the differentiator (plan §3/§6). Computed over the
    RESOLVED edges ONLY, so the formal part is complete-by-construction:

      - isolated-core : a core no link reaches → the anchor touches it but the wiring is
        unseen (a TRUE shadow, or a missed edge — §5 audits which).
      - dangling-link : a link reaching no core → wires to something outside this view.
      - link-only     : links but no core at all (a pure rewire view).

    These are POSTURES, not errors (a dangling link can legitimately point outside the
    anchor's neighborhood). `assert_resolved_only` guards `g.edges` itself: in codebase mode
    that list is contractually resolved-only, so a non-resolved edge slipping into the
    resolved adjacency would make the map lie with confidence (plan §1) — it RAISES. (A
    diff-mode graph, whose edges are HEUR, correctly cannot be passed here: it makes no
    completeness promise, so it must not use the completeness-bearing op — §2.)
    """
    assert_resolved_only(g.edges)                       # the spine, on the real adjacency
    adj = undirected_adjacency(g.edges)
    cores = {n.id for n in g.nodes.values() if n.role == "core"}
    links = {n.id for n in g.nodes.values() if n.role == "link"}
    # A CONTAINER core (a node whose symbol encloses other cores — e.g. the anchor class
    # holding its methods) is wired THROUGH its members, so it is never isolated on its own.
    # Only leaf behavior units are judged — that is where a true shadow (a DI-wired method)
    # shows up, not on the class declaration.
    container_labels = {g.nodes[c].enclosing for c in cores if g.nodes[c].enclosing}
    seam_warnings: dict[str, list[str]] = {}
    for c in cores:
        if g.nodes[c].label and g.nodes[c].label in container_labels:
            continue
        if not (adj.get(c, set()) & links):
            seam_warnings.setdefault(c, []).append("isolated-core")
    node_warnings: dict[str, list[str]] = {}
    for ln in links:
        if not (adj.get(ln, set()) & cores):
            node_warnings.setdefault(ln, []).append("dangling-link")
    return {
        "postures": {
            "cores": len(cores), "links": len(links),
            "environment": sum(1 for n in g.nodes.values() if n.role == "environment"),
            "isolated_cores": sum("isolated-core" in w for w in seam_warnings.values()),
            "dangling_links": sum("dangling-link" in w for w in node_warnings.values()),
            "link_only": bool(links and not cores),
            "unresolved": len(g.unresolved),     # UNKNOWN count — honest gaps, not "no link"
            "blindspots": len(g.blindspots),     # statically-opaque mechanisms (SUGGESTED)
        },
        "seam_warnings": seam_warnings,
        "node_warnings": node_warnings,
    }
