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
    complexity: int = 0             # "aboutness" magnitude — decisions (diff) / nesting (codebase)
    # filled by the (mode-specific) assignment passes:
    role: str = ""                  # core | link | environment | test | noise | ""
    role_confidence: float = 1.0
    group: str = ""                 # cluster id (Layer 4 output)
    intent: str = ""                # cluster label
    seam: str = ""                  # for a core: the seam id it anchors
    seam_label: str = ""


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
    anchor: str = ""
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
        for t in (h.wires or []):
            if t in present:
                g.edges.append(Edge(src=h.id, dst=t, kind="wires", provenance=provenance))
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
