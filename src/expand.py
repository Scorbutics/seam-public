"""Expansion: GROW an intent footprint by merging another scan into the current graph (plan P2).

The manual expand-seam loop: you pick a link/boundary node and expand the intent THAT direction.
Mechanically that's a fresh scan from the picked node, MERGED into the accumulating ResolvedGraph
so the footprint widens (and the partition is recomputed over the union). Two principles:

  - **Content-key dedup, not a global id rewrite.** A node reached from two anchors is the SAME node
    (`file#line`); merging dedups on that key and remaps the incoming edges. The per-scan id scheme
    (and the harness golds keyed on it) is left untouched — identity is reconciled at MERGE time.
  - **Expansion accumulates ANCHORS.** Each expanded node becomes a new core/sub-anchor; the grown
    graph carries `anchors` (the lineage), and roles are computed relative to that whole set (so the
    original anchor AND each expanded node are cores). See `codebase.assign_roles`.

Pure dict-in/dict-out over the `ResolvedGraph` contract — no graph_ir, no LLM, offline-testable.
"""
from __future__ import annotations

import copy


def _key(n: dict) -> str:
    """The content identity of a node across scans: file + definition start line. Two scans that
    reach the same symbol agree on this, so it dedups them into one merged node."""
    rng = n.get("range") or [0, 0]
    return f"{n.get('file', '')}#{rng[0] if rng else 0}"


def merge_resolved(base: dict, add: dict, *, expand_anchor: str | None = None) -> dict:
    """Merge ResolvedGraph `add` INTO `base` (both the resolver/scan JSON contract) and return the
    union. Nodes dedup by `_key`; `add`'s edges/blindspots/unresolved are remapped onto the surviving
    ids. `expand_anchor` (an id IN `add`, e.g. the node the user expanded) is added to the merged
    `anchors` lineage; otherwise `add`'s own anchor is — so the expanded node becomes a core, and a
    DOWN expansion's deps (NOT in `add.anchors`) stay links adjacent to it. Idempotent on identical."""
    merged = copy.deepcopy(base)
    by_key: dict[str, str] = {_key(n): n["id"] for n in merged["nodes"]}
    used_ids: set[str] = {n["id"] for n in merged["nodes"]}

    idmap: dict[str, str] = {}                       # add id → merged id
    for n in add["nodes"]:
        k = _key(n)
        if k in by_key:                              # same node reached again → dedup
            idmap[n["id"]] = by_key[k]
            continue
        nid = n["id"]
        if nid in used_ids:                          # id collides across scans → give it a fresh one
            nid = f"x{len(used_ids)}"
            while nid in used_ids:
                nid = f"x{len(used_ids)}_{nid}"
        idmap[n["id"]] = nid
        used_ids.add(nid)
        by_key[k] = nid
        merged["nodes"].append({**n, "id": nid})

    present = {n["id"] for n in merged["nodes"]}
    eset = {(e["from"], e["to"], e.get("kind", "")) for e in merged["edges"]}
    for e in add["edges"]:
        f, t = idmap.get(e["from"], e["from"]), idmap.get(e["to"], e["to"])
        key = (f, t, e.get("kind", ""))
        if f in present and t in present and key not in eset:
            eset.add(key)
            merged["edges"].append({**e, "from": f, "to": t})

    for bs in add.get("blindspots", []):             # remap the node a blind spot hangs off
        merged.setdefault("blindspots", []).append({**bs, "node": idmap.get(bs.get("node"), bs.get("node"))})
    for u in add.get("unresolved", []):
        merged.setdefault("unresolved", []).append({**u, "node": idmap.get(u.get("node"), u.get("node"))})

    base_anchors = merged.get("anchors") or [merged.get("anchor", {}).get("id")]
    # union the incoming graph's anchors (the expanded source becomes a core), remapped, plus the
    # explicitly-expanded node. A DOWN expansion's deps are NOT in add.anchors, so they stay links.
    add_anchors = [idmap.get(a, a) for a in (add.get("anchors") or [add.get("anchor", {}).get("id")])]
    extra = [idmap.get(expand_anchor, expand_anchor)] if expand_anchor else []
    merged["anchors"] = list(dict.fromkeys([a for a in [*base_anchors, *add_anchors, *extra] if a]))
    merged["complete"] = bool(merged.get("complete", True)) and bool(add.get("complete", True))
    return merged
