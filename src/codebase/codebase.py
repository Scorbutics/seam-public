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
from ..core import graph_ir
from ..core import llm
from ..core.graph_ir import (BlindSpot, Edge, Graph, Provenance, connected_components,
                       undirected_adjacency, wellformedness)

# Role confidence == how structural the call is. Core/test are structural facts; link is a
# resolved adjacency to a core; environment is the residual (lowest, surfaces as soft).
_CONF_CORE = 1.0
_CONF_TEST = 1.0
_CONF_LINK = 0.9
_CONF_ENV = 0.6


def assign_roles(g: Graph) -> None:
    """Layer 3: anchor-relative roles over the RESOLVED adjacency. Mutates `g.nodes`. With expansion
    (P2) the graph has MULTIPLE anchors (the lineage); core = the union of every anchor + its members,
    so the original seed AND each expanded node are cores, and links/env are relative to that set."""
    anchor_ids = [a for a in (g.anchors or [g.anchor]) if a in g.nodes]
    anchor_syms = {g.nodes[a].label for a in anchor_ids if g.nodes[a].label}
    adj = undirected_adjacency(g.resolved_edges())

    core = {n.id for n in g.nodes.values()
            if n.id in anchor_ids or (n.enclosing and n.enclosing in anchor_syms)}
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


_AREA_MARKERS = ("modules", "features", "packages", "src", "apps", "app", "lib")


def _area(path: str) -> str:
    """A coarse 'where in the system' label for a consumer file — the feature segment after a
    layout marker (e.g. `…/modules/billing/…` → `billing`), else the directory. The intent
    signal for single-member cores (calibration §11.2). Deliberately coarse + tunable; it leans
    on a tidy layout (cal.com modules, kernel subsystems) and degrades gracefully on flat repos."""
    parts = [p for p in path.split("/") if p]
    for marker in _AREA_MARKERS:
        if marker in parts:
            seg = parts[parts.index(marker) + 1: parts.index(marker) + 3]
            if seg:
                return "/".join(seg)
    return "/".join(parts[:-1]) or path


def _mk_seam(sid: str, label: str, node_ids: list[str], link_only: bool,
             proposed_by: str = "floor") -> dict:
    return {"id": sid, "label": label or sid, "linkOnly": link_only,
            "node_ids": list(node_ids), "proposedBy": proposed_by}


def _is_crossing(e: Edge) -> bool:
    """A boundary crossed by HEURISTIC, not a hard binding — a string-dispatch (tier 2, kind
    'dispatch') or an assumed (SUGGESTED) edge. It LINKS seams but must not FUSE them: the target is
    the OTHER side of a boundary (a separate intent), so it earns its own SUGGESTED seam rather than
    being pulled into the source's. (RESOLVED_PARTIAL alone is NOT a crossing — class-method
    attribution is ordinary usage; only the dispatch/assumed kinds delimit.)"""
    return e.kind == "dispatch" or e.provenance == Provenance.SUGGESTED


def _hard_reachable(g: Graph) -> set[str]:
    """Nodes reachable from the ORIGINAL anchor over NON-crossing edges (+ containment) — the footprint
    reached by HARD bindings (imports / resolved calls). Anything OUTSIDE was reached only across a
    heuristic crossing (string-dispatch / assumed), so its seam is SUGGESTED: you believe it only as
    far as you believe the crossing — even after you follow it (expand into its body), the hop in was
    still an assumption. Seeds from `g.anchor` (the original seed), NOT the expanded lineage."""
    adj: dict[str, set[str]] = {}
    def link(a: str, b: str) -> None:
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)
    for e in g.resolved_edges():
        if not _is_crossing(e):
            link(e.src, e.dst)
    for a, b in _containment_edges(g):
        link(a, b)
    seed = [g.anchor] if g.anchor in g.nodes else [a for a in (g.anchors or []) if a in g.nodes]
    seen, stack = set(seed), list(seed)
    while stack:
        for nb in adj.get(stack.pop(), ()):
            if nb not in seen:
                seen.add(nb)
                stack.append(nb)
    return seen


def _extract_suggested_seams(g: Graph, seams: list[dict]) -> list[dict]:
    """Make crossings read as distinct hops, then flag the suggested side. (1) SPLIT: pull a non-anchor
    crossing TARGET out of the seam it fused into, into its own seam (else `assign_clusters` keeps it
    fused via the resolved-partial edge). (2) MARK: any seam reached from the original anchor ONLY
    across a crossing is `suggested` — this also catches a FOLLOWED crossing (expanded into an anchor),
    which stacking gives its own seam but reachability still marks suggested. The crossing edge itself
    survives in `edges`/contracts as the (blurry) chain link; only the GRAIN + the flag change."""
    anchors = set(g.anchors or [g.anchor])
    targets = {e.dst for e in g.resolved_edges() if _is_crossing(e) and e.dst not in anchors}
    out: list[dict] = []
    made: dict[str, dict] = {}
    for s in seams:
        rest = [n for n in s["node_ids"] if n not in targets]
        ts = [n for n in s["node_ids"] if n in targets]
        if rest or not ts:
            s["node_ids"] = rest or s["node_ids"]
            out.append(s)
        for t in ts:
            if t not in made:
                node = g.nodes[t]
                made[t] = _mk_seam(f"sug-{t}", node.label or t, [t],
                                   link_only=(node.role != "core"), proposed_by="crossing")
                out.append(made[t])
    hard = _hard_reachable(g)
    for s in out:                                   # believe a seam only as far as you believe its crossing
        if s["node_ids"] and all(nid not in hard for nid in s["node_ids"]):
            s["suggested"] = True
    return out


def _sweep_leftovers(g: Graph, seams: list[dict], adj: dict) -> list[dict]:
    """Place any reached node not yet in a seam into an adjacent seam (else the first) — so nothing
    resolved is silently dropped. Includes leftover CORES: after a multi-anchor expansion the new
    anchors' cores (e.g. an expanded dependency like RolesService→RolesList) aren't the primary
    anchor's `members`, so the LLM refine never groups them — without this they'd vanish from every
    seam (the "expand added nothing" bug). Tests render separately, so they're left out. Dedups."""
    placed = {nid for s in seams for nid in s["node_ids"]}
    for n in g.nodes.values():
        if n.role in ("core", "link", "environment") and n.id not in placed:
            host = next((s for s in seams if adj.get(n.id, set()) & set(s["node_ids"])),
                        seams[0] if seams else None)
            if host is not None:
                host["node_ids"].append(n.id)
    for s in seams:
        s["node_ids"] = list(dict.fromkeys(s["node_ids"]))
    return seams


def assign_intent_seams(g: Graph) -> list[dict]:
    """F2 — the deterministic intent FLOOR (a PROPOSED partition; the LLM refines it later).

    Carriers = the anchor's MEMBER cores (a class's methods / a module's functions); a single
    flat core (a component) is its own carrier. Partition by CO-OCCURRENCE: members USED TOGETHER
    by the same consumer share a seam (calibration §11.1, e.g. {DEFAULT_SCHEDULE,
    getAvailabilityFromSchedule}). Consumers attach to the seam(s) they use; the anchor CORE
    attaches to EACH (⇒ many-to-many for free). When there's only ONE carrier (member-usage can't
    separate, §11.2 useHasPaidPlan), fall back to clustering consumers by module-AREA. Reached env
    is swept into an adjacent seam so nothing resolved is dropped.

    Returns a list of seam dicts (`node_ids` may overlap — the many-to-many). NOT a partition of
    nodes; a reading over them. Deterministic ≠ resolved: this is a proposal, not a fact.
    """
    anchors = [a for a in (g.anchors or [g.anchor]) if a in g.nodes]
    if not anchors:
        return []
    adj = undirected_adjacency(g.resolved_edges())

    # Carriers = EACH anchor's member cores (else the anchor itself). With expansion (P2) there are
    # several anchors; carrier_anchor records which anchor a carrier belongs to, so a seam can name
    # its owning anchor(s) and cross-anchor wiring can fuse the grown intent.
    carriers: list = []
    carrier_anchor: dict[str, str] = {}
    seen_c: set[str] = set()
    for a in anchors:
        a_sym = g.nodes[a].label
        members = [n for n in g.nodes.values()
                   if n.role == "core" and n.id != a and n.enclosing == a_sym]
        for c in (members if members else [g.nodes[a]]):
            if c.id not in seen_c:
                seen_c.add(c.id)
                carriers.append(c)
                carrier_anchor[c.id] = a
    cset = {c.id for c in carriers}
    consumers = [n for n in g.nodes.values() if n.role == "link"]
    uses: dict[str, set[str]] = {}                      # consumer → carriers (or whole-anchors) it uses
    for con in consumers:
        used = {cid for cid in cset if cid in adj.get(con.id, set())}
        if not used:
            used = {a for a in anchors if a in adj.get(con.id, set())}   # used an anchor as a whole
        uses[con.id] = used

    anchor0 = anchors[0]
    anchor0_sym = g.nodes[anchor0].label
    seams: list[dict] = []
    if len(carriers) > 1 and any(uses.values()):
        # multi-member: co-occurrence of carriers used together by the same consumer. A consumer
        # that touches MOST carriers is AMBIENT (a broad user / shared util, not an intent signal)
        # — it must not fuse them (the cal.com hairball lesson, at the carrier level); it still
        # ATTACHES below to every seam it uses (many-to-many).
        cut = max(2, len(carriers) // 2)
        cooc: list[tuple[str, str]] = []
        for used in uses.values():
            u = sorted(used & cset)
            if len(u) > cut:
                continue                           # ambient consumer → no co-occurrence edge
            cooc += [(u[0], x) for x in u[1:]]
        # CROSS-ANCHOR edges are NOT fused: each expansion hop (a deliberately-grown anchor) is a
        # DISTINCT intent → its OWN seam, STACKED, not merged into the source. The core→core edge
        # between anchors survives as a seam CONTRACT (the chain link), so the chain reads as
        # PaymentsTab → invokeProcessPayment ↝ process-payment, not one blob. (Single-anchor
        # partitioning is untouched — there are no cross-anchor carriers, so the golds are unchanged.)
        cluster_of = connected_components([c.id for c in carriers], cooc)
        by_cluster: dict[str, list[str]] = {}
        for cid in cset:
            by_cluster.setdefault(cluster_of[cid], []).append(cid)
        for cids in by_cluster.values():
            cs = set(cids)
            cons = [cid for cid, u in uses.items() if u & cs]
            rep = max((g.nodes[c] for c in cids), key=lambda n: n.complexity)
            owners = [a for a in anchors if a in cs or g.nodes[a].label in {g.nodes[c].enclosing for c in cs}]
            seams.append(_mk_seam(rep.id, rep.label, [*owners, *sorted(cids), *cons], link_only=False))
    else:
        # single carrier total (one anchor, one member): split consumers by module-area
        by_area: dict[str, list[str]] = {}
        for con in consumers:
            by_area.setdefault(_area(con.file), []).append(con.id)
        if not by_area:
            seams.append(_mk_seam(anchor0, anchor0_sym, [anchor0], link_only=False))
        for area, cons in by_area.items():
            seams.append(_mk_seam(f"{anchor0}@{area}", f"{anchor0_sym} · {area}", [anchor0, *cons], link_only=False))

    return _sweep_leftovers(g, seams, adj)      # place reached env, drop nothing


# --------------------------------------------------------------------------- F4: LLM refine
def _build_refine_prompt(g: Graph, members: list, floor_of: dict, uses: dict,
                         intent: str | None = None) -> str:
    """Prompt the LLM to refine the FLOOR partition into named technical intents. It is given the
    carriers (members), the deterministic floor grouping as a STARTING POINT, and which consumers
    use which carriers (the co-occurrence evidence). It regroups + names — it MUST only use the
    given carrier ids. When an `intent` (the user's question) is given, the SAME pass also marks the
    one seam that best answers it (`match`) — fused to save a round-trip; partition is unchanged."""
    anchor_sym = g.nodes[g.anchor].label if g.anchor in g.nodes else g.anchor
    lines = [
        f"A code symbol `{anchor_sym}` has these MEMBERS (carriers). Group them into technical-intent",
        "SEAMS (one or more members that serve the same purpose) and NAME each intent (3-6 words).",
        "A deterministic FLOOR grouping is given as a starting point — keep it unless the big picture",
        "says merge or split. Use ONLY the member ids listed; invent nothing.",
        "",
        "MEMBERS (id [floor-group]: symbol):",
    ]
    for m in members:
        lines.append(f"  {m.id} [{floor_of.get(m.id, '?')}]: {m.label}")
    lines.append("\nCONSUMERS (who uses which members — members used together suggest one intent):")
    for cid, used in uses.items():
        if used:
            lines.append(f"  {g.nodes[cid].label} → {', '.join(used)}")
    if intent:
        lines.append(f'\nThe user is asking: "{intent}". On the members of the ONE seam that best '
                     'answers that question, set "match": true (leave it false/absent on all others).')
        lines.append('\nOutput ONLY a JSON array, one object per MEMBER:')
        lines.append('[{"id":"<member id>","seam":"S1","label":"<intent name>","match":false}]')
    else:
        lines.append('\nOutput ONLY a JSON array, one object per MEMBER:')
        lines.append('[{"id":"<member id>","seam":"S1","label":"<intent name>"}]')
    return "\n".join(lines)


def refine_seams_llm(g: Graph, floor_seams: list[dict], *, intent: str | None = None,
                     model: str = "claude-haiku-4-5", claude_bin: str | None = None,
                     verbose: bool = False) -> list[dict]:
    """F4: the LLM refines the FLOOR partition into named technical-intent seams — a PROPOSED
    partition over the VERIFIED carriers. It regroups + names the given member ids; it CANNOT
    invent a carrier (unknown ids are dropped) or an edge (it never touches the resolved graph).
    Seeded by the floor for stability. Falls back to the floor on any failure (no LLM / parse).
    When `intent` is given, the SAME pass also marks the best-matching seam (`selected` on it) —
    fused selection (P1), so the question focuses one seam without a second round-trip."""
    anchor = g.anchor
    anchor_node = g.nodes.get(anchor)
    if anchor_node is None:
        return floor_seams
    members = [n for n in g.nodes.values()
               if n.role == "core" and n.id != anchor and n.enclosing == anchor_node.label]
    if len(members) < 2:
        return floor_seams                          # single core / area-fallback — nothing to refine
    consumers = [n for n in g.nodes.values() if n.role == "link"]
    adj = undirected_adjacency(g.resolved_edges())
    cset = {m.id for m in members}
    uses = {c.id: sorted(cset & adj.get(c.id, set())) for c in consumers}
    floor_of: dict[str, str] = {}
    for s in floor_seams:
        for nid in s["node_ids"]:
            if nid in cset:
                floor_of[nid] = s["id"]

    try:
        out = llm.run_pass(_build_refine_prompt(g, members, floor_of, uses, intent),
                           model=model, claude_bin=claude_bin, tag="seam-refine", verbose=verbose)
    except llm.LLMError:
        return floor_seams                          # degrade to the floor (still a valid proposal)

    grouping: dict[str, str] = {}
    labels: dict[str, str] = {}
    match_votes: dict[str, int] = {}                # fused selection: which seam answers the intent
    for cid, obj in out.items():
        if cid in cset and isinstance(obj, dict):   # ONLY known carriers — cannot invent
            sk = str(obj.get("seam", "")).strip()
            if sk:
                grouping[cid] = sk
                lab = str(obj.get("label", "")).strip()
                if lab:
                    labels.setdefault(sk, lab)
                if intent and obj.get("match") in (True, "true", "True", 1):
                    match_votes[sk] = match_votes.get(sk, 0) + 1
    if not grouping:
        return floor_seams
    for m in members:                               # carriers the LLM didn't place → keep floor group
        grouping.setdefault(m.id, floor_of.get(m.id, m.id))
    selected_sk = max(match_votes, key=match_votes.get) if match_votes else None

    by_seam: dict[str, list[str]] = {}
    for cid, sk in grouping.items():
        by_seam.setdefault(sk, []).append(cid)
    seams: list[dict] = []
    for sk, cids in by_seam.items():
        cs = set(cids)
        cons = [c.id for c in consumers if cs & set(uses[c.id])]
        rep = max((g.nodes[c] for c in cids), key=lambda n: n.complexity)
        seam = _mk_seam(rep.id, labels.get(sk) or rep.label, [anchor, *sorted(cids), *cons],
                        link_only=False, proposed_by="llm")
        if sk == selected_sk:
            seam["selected"] = True                 # the seam that best answers the intent (focus)
        seams.append(seam)
    return _sweep_leftovers(g, seams, adj)


def _relevance_prompt(intent: str, cores: list, links: list) -> str:
    lines = [f'A developer is mapping the code that answers: "{intent}".', "",
             "FOCUS — the core code this question is about:"]
    lines += [f"  {n.label}  ({n.file})" for n in cores[:30]]
    lines += ["",
              "CANDIDATE WIRING — code reached while mapping the question. For EACH, decide if it is ON",
              "the path to answering it (relevant), or INCIDENTAL — connected but not part of the answer",
              "(session/auth setup, logging, config, generic utilities, an unrelated sibling import):"]
    lines += [f"  {n.id}: {n.label}  ({n.file})" for n in links]
    lines += ["",
              "Default to relevant when unsure; mark incidental ONLY when clearly off the answer path.",
              "Output ONLY a JSON array, one object per candidate:",
              '[{"id":"<id>","relevant":true|false}]']
    return "\n".join(lines)


def mark_relevance_llm(g: Graph, intent: str, *, model: str = "claude-haiku-4-5",
                       claude_bin: str | None = None, verbose: bool = False) -> None:
    """Mark-relevance: tag each LINK as ON-the-answer-path (relevant) or INCIDENTAL relative to
    `intent`. ADDITIVE — sets `n.relevant` (default True), never drops a node (the UI DIMS the
    incidental, so completeness stays honest). Cores are the deliberate focus → always relevant.
    Needs an LLM (relevance to a question is semantic, not structural); degrades to all-relevant on
    any failure. One thinking-off pass, so it stays inside the generation budget."""
    links = [n for n in g.nodes.values() if n.role == "link"]
    if not intent or not links:
        return
    cores = [n for n in g.nodes.values() if n.role == "core"]
    try:
        out = llm.run_pass(_relevance_prompt(intent, cores, links),
                           model=model, claude_bin=claude_bin, tag="relevance", verbose=verbose)
    except llm.LLMError:
        return                                      # degrade: nothing dimmed (all stay relevant)
    for n in links:
        obj = out.get(n.id)
        if isinstance(obj, dict) and obj.get("relevant") in (False, "false", "False", 0):
            n.relevant = False                      # incidental → the UI dims it (kept, not dropped)


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


def decompose(g: Graph, repo: str | None = None, *, use_llm: bool = False, intent: str | None = None,
              model: str = "claude-haiku-4-5", claude_bin: str | None = None) -> dict:
    """Run the codebase layers (roles → clusters → blind spots/sub-cores/contract → intent FLOOR
    → optional LLM refine → well-formedness) and return the SeamModel. `g` is mutated. `repo`
    enables the Layer-2 scan + A/B substrate. `use_llm` lets the LLM refine the floor partition
    (a PROPOSED partition, seeded by the floor; degrades to the floor if no LLM). `intent` (the
    user's question, P1) fuses seam SELECTION into the refine pass — the matching seam is marked
    `selected` so the renderer can focus it (needs use_llm; ignored by the deterministic floor)."""
    from src.core import progress
    progress.emit("Classifying roles & grouping…")
    assign_roles(g)
    assign_clusters(g)
    if repo:
        progress.emit("Detecting hidden couplings…")
        detect_dynamic_import_blindspots(g, repo)
        detect_subcores(g, repo)
        detect_contract(g, repo)
        detect_consumer_feeds(g, repo)          # A2: complete each prop thread with its feeders
    progress.emit("Partitioning into seams…")
    seams = assign_intent_seams(g)              # F2: the deterministic intent floor (proposed)
    if use_llm:                                 # F4: the LLM refines/names the partition (proposed)
        progress.emit("Refining seams with the LLM…")
        seams = refine_seams_llm(g, seams, intent=intent, model=model, claude_bin=claude_bin)
        if intent:                              # F5: mark-relevance — dim incidental wiring (additive)
            progress.emit("Marking relevance with the LLM…")
            mark_relevance_llm(g, intent, model=model, claude_bin=claude_bin)
    seams = _extract_suggested_seams(g, seams)  # F6: a crossing (string-dispatch/assumed) → its OWN seam
    progress.emit("Checking well-formedness…")
    health = wellformedness(g)
    return emit_seams(g, health, seams)


# --------------------------------------------------------------------------- emit (SeamModel)
def _seam_hunk(n: graph_ir.Node, provenance: str) -> dict:
    """A node rendered as a SeamHunk (the extension's per-line decoration unit). Mirrors the
    diff `emit_seams_json` shape so the native renderer is unchanged; `provenance` is the
    new per-edge-honesty field (diff-mode hunks are implicitly HEUR). A core may also carry
    `subcores` — a PROPOSED behavioural partition (Model B), additive and clearly flagged."""
    out = {"id": n.id, "file": n.file, "start": n.start, "end": n.end,
           "role": n.role, "confidence": round(n.role_confidence, 2),
           "label": n.label, "provenance": provenance, "relevant": n.relevant,
           "external": [], "externalRefs": [], "rewire": None}
    if n.subcores:
        out["subcores"] = n.subcores
    if n.contract:
        out["contract"] = n.contract
    return out


def _seam_contracts(g: Graph, seams: list[dict]) -> list[dict]:
    """The CONTRACT between seams: for each PAIR of seams, the symbol→symbol edges that BRIDGE them
    (an endpoint in each), i.e. what one intent depends on from another. Excludes containment (a
    method living in its class is structure, not a contract) and the shared anchor (its core is in
    every seam — not a boundary). A contract is BLURRY when any bridging edge is heuristic
    (RESOLVED_PARTIAL) or assumed (SUGGESTED) — the case a reviewer most needs to eyeball."""
    node_seams: dict[str, set[str]] = {}
    for s in seams:
        for nid in s["node_ids"]:
            node_seams.setdefault(nid, set()).add(s["id"])
    pairs: dict[tuple[str, str], list[dict]] = {}
    seen: set[tuple] = set()
    for e in g.resolved_edges():
        if e.kind == "contains":          # containment is structure, not a contract
            continue
        # (the anchor is no longer excluded: with stacked seams it lives in ONE seam, so its edges to
        # other seams ARE the chain's contracts — the first hop. The a==b check below drops any edge
        # whose endpoints still share a seam, so a many-to-many anchor never mints a self-contract.)
        for a in node_seams.get(e.src, ()):
            for b in node_seams.get(e.dst, ()):
                if a == b:
                    continue
                key = (a, b) if a < b else (b, a)        # unordered seam pair
                dk = (key, e.src, e.dst, e.kind)
                if dk in seen:
                    continue
                seen.add(dk)
                pairs.setdefault(key, []).append(
                    {"from": e.src, "to": e.dst, "kind": e.kind, "provenance": e.provenance.value,
                     "line": e.line})
    out = []
    for (a, b), links in pairs.items():
        blurry = any(l["provenance"] != "RESOLVED_FULL" for l in links)
        out.append({"seamA": a, "seamB": b, "links": links, "blurry": blurry})
    return out


def emit_seams(g: Graph, health: dict, seams: list[dict]) -> dict:
    """Assemble the SeamModel from the F2 intent-seam list. Each intent-seam renders as a SeamModel
    seam (under one cluster — product-intent grouping is the LLM's later job); a node may appear in
    several seams (the many-to-many — e.g. the anchor core in each intent it serves). Warnings come
    from Layer 6; tests + honest-gap overlays are top-level; `resolutionQuality` rides along."""
    edge_prov = {(e.src, e.dst): e.provenance.value for e in g.resolved_edges()}
    seam_warnings = health.get("seam_warnings", {})
    node_warnings = health.get("node_warnings", {})
    anchor_sym = g.nodes[g.anchor].label if g.anchor in g.nodes else ""

    def prov_of(nid: str, others: set[str]) -> str:
        for o in others:
            p = edge_prov.get((nid, o)) or edge_prov.get((o, nid))
            if p:
                return p
        return "RESOLVED_FULL"

    out_seams = []
    for s in seams:
        ids = sorted(s["node_ids"], key=lambda i: (g.nodes[i].file, g.nodes[i].start))
        idset = set(ids)
        hunks = [_seam_hunk(g.nodes[i], "RESOLVED_FULL" if g.nodes[i].role == "core"
                            else prov_of(i, idset)) for i in ids]
        # inbound CALLERS (the chain UPSTREAM): a node OUTSIDE this seam that reaches a core IN it →
        # a link node positioned at the CALL SITE (the edge's call line), so the seam shows WHO calls
        # it — navigable to the `await foo()` — not only its own deps. Cross-seam only, deduped.
        seen_c: set[tuple[str, str]] = set()
        for e in g.resolved_edges():
            if e.kind == "contains" or e.dst not in idset or e.src in idset:
                continue
            c = g.nodes.get(e.src)
            if c is None or (e.src, e.dst) in seen_c:
                continue
            seen_c.add((e.src, e.dst))
            cl = e.line if (e.line and e.line > 0) else c.start
            hunks.append({"id": f"call:{e.src}:{e.dst}", "file": c.file, "start": cl, "end": cl,
                          "role": "link", "confidence": 0.9, "label": c.label, "caller": True,
                          "provenance": e.provenance.value, "relevant": c.relevant,
                          "external": [], "externalRefs": [], "rewire": None})
        warns: list[str] = []
        for i in ids:
            for w in seam_warnings.get(i, []) + node_warnings.get(i, []):
                if w not in warns:
                    warns.append(w)
        out_seams.append({"id": s["id"], "label": s["label"], "linkOnly": s["linkOnly"],
                          "uncertain": False, "warnings": warns, "hunks": hunks,
                          "proposedBy": s.get("proposedBy", "floor"), "selected": s.get("selected", False),
                          "suggested": s.get("suggested", False)})

    selected_seam = next((s["id"] for s in out_seams if s.get("selected")), "")
    clusters = [{"id": "g1", "intent": anchor_sym or g.anchor, "colorIndex": 0, "seams": out_seams}]
    tests = [_seam_hunk(n, "RESOLVED_FULL") for n in g.nodes.values() if n.role == "test"]
    return {
        "clusters": clusters,
        "tests": tests,
        "noise": [],
        # codebase-mode additions (extension reads additively; diff-mode omits them):
        "mode": "codebase",
        "selectedSeam": selected_seam,          # P1: the seam matching the user's intent (focus), or ""
        "anchor": g.anchor,
        "resolutionQuality": g.resolution_quality,
        "language": g.language,
        "complete": g.complete,
        # seam-to-seam wiring is reserved for between genuinely distinct intents (S2/S3); the
        # floor's many-to-many is carried by shared nodes (the core appearing in several seams).
        "seamEdges": [],
        # the raw directed graph — every resolved symbol→symbol edge with its relation + provenance,
        # so the CHAIN view can restitute the call/dependency graph (RESOLVED / RESOLVED_PARTIAL).
        "edges": [{"from": e.src, "to": e.dst, "kind": e.kind, "provenance": e.provenance.value,
                   "line": e.line} for e in g.resolved_edges()],
        # the seam-to-seam CONTRACT: which symbols bridge each pair of seams + how solid (blurry when
        # any bridging edge is heuristic/assumed) — the inter-seam boundary a reviewer validates.
        "seamContracts": _seam_contracts(g, seams),
        "blindspots": [{"node": b.node, "mechanism": b.mechanism, "evidence": b.evidence,
                        "candidates": [{"symbol": c.dst, "provenance": c.provenance.value}
                                       for c in b.candidates]} for b in g.blindspots],
        "unresolved": g.unresolved,
        "health": health.get("postures", {}),
    }
