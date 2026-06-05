"""Render decomposed hunks into a single self-contained HTML report.

Primary axis is the INTENT CLUSTER, not the role — this is what makes the view
triangulate (§3): inside one cluster you see the core and the links that wire it
in, adjacent, so "links tell you where to expect cores" and the self-check
("why is this core linked *here*?") has something to fire against.

Within a cluster, hunks are shown per role (core → link → environment), and
multiple hunks from the same file are merged into one diff block. diff2html
groups file-by-file by design — we lean on that *inside* a role block, but the
top-level structure is intent, which diff2html could never give us.

Noise (formatting/rename/binary) is pulled out into one global section — it is a
different tier (§2), not part of any intent's triangulation.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import ROLE_DESCRIPTIONS
from .parser import Hunk

_TEMPLATE_DIR = Path(__file__).parent / "templates"

# Order roles within a cluster so the core is read first, then its links.
_CLUSTER_ROLES = ("core", "link", "environment")

# A seam whose core got LESS than this share of the self-consistency votes is shown
# as "uncertain" — the model was genuinely split on whether it's a distinct core.
UNCERTAIN_THRESHOLD = 0.6

# Distinct hues per intent cluster for the graph view — one box/colour per
# intent, cycled if there are more clusters than colours. Chosen to read on both
# light and dark backgrounds (the boxes use a translucent tint of the same hue).
_CLUSTER_COLORS = (
    "#e86b9a",  # pink
    "#6bbf73",  # green
    "#4fd0b0",  # mint
    "#e8a07a",  # peach
    "#8b7bd8",  # violet
    "#5aa9e6",  # blue
    "#e6c34f",  # amber
    "#d87ad8",  # magenta
)


def _is_renderable(hunk: Hunk) -> bool:
    """Only real textual hunks can go through diff2html."""
    return not hunk.is_binary and hunk.text.lstrip().startswith("@@")


def _merged_diff(hunks: list[Hunk]) -> str:
    """One parseable unified diff for a set of hunks, MERGED per file.

    One `diff --git` + `---`/`+++` header per file, then all that file's hunks
    underneath (the "merge per file" behaviour). Original @@ line numbers are
    kept verbatim — diff2html does not need contiguous hunks.
    """
    by_file: dict[str, list[Hunk]] = {}
    order: list[str] = []
    for h in hunks:
        if not _is_renderable(h):
            continue
        sk = "|".join((h.source_file, h.target_file, h.file_path))
        if sk not in by_file:
            by_file[sk] = []
            order.append(sk)
        by_file[sk].append(h)

    chunks: list[str] = []
    for sk in order:
        file_hunks = by_file[sk]
        first = file_hunks[0]
        a = first.source_file or f"a/{first.file_path}"
        b = first.target_file or f"b/{first.file_path}"
        ga = first.file_path if a == "/dev/null" else a[2:] if a.startswith("a/") else a
        gb = first.file_path if b == "/dev/null" else b[2:] if b.startswith("b/") else b
        chunks.append(f"diff --git a/{ga} b/{gb}")
        chunks.append(f"--- {a}")
        chunks.append(f"+++ {b}")
        for h in file_hunks:
            chunks.append(h.text.rstrip("\n"))
    return "\n".join(chunks) + ("\n" if chunks else "")


def _notes(hunks: list[Hunk]) -> list[str]:
    """Human-readable notes for hunks that can't be shown as a diff (renames/binary)."""
    return [
        f"{h.id} · {h.file_path}: {h.text.strip()}"
        for h in hunks
        if not _is_renderable(h)
    ]


def _file_items(hunks: list[Hunk]) -> list[dict]:
    """Per-file summary rows (file + the structuring rationales) for a role block."""
    by_file: dict[str, dict] = {}
    order: list[str] = []
    for h in hunks:
        if h.file_path not in by_file:
            by_file[h.file_path] = {"file": h.file_path, "ids": [], "rationales": []}
            order.append(h.file_path)
        by_file[h.file_path]["ids"].append(h.id)
        if h.rationale and h.rationale not in by_file[h.file_path]["rationales"]:
            by_file[h.file_path]["rationales"].append(h.rationale)
    return [by_file[f] for f in order]


def _build_clusters(hunks: list[Hunk]) -> tuple[list[dict], dict[str, str]]:
    """Assemble intent clusters and the diff strings they reference.

    Returns (clusters, diffs) where each cluster has role blocks, and `diffs`
    maps a diff key (e.g. "g1-core") to its unified-diff string.
    """
    # Tests are NOT part of a seam's logic — they COVER cores (skim posture). They
    # are kept out of the seam decomposition (so they don't hub the wiring) and
    # surfaced separately, with the seams they cover marked tested.
    covered_seams = {w for h in hunks if h.role == "test" for w in h.wires}
    non_noise = [h for h in hunks if h.role not in ("noise", "test")]

    # Preserve first-appearance order of groups.
    group_order: list[str] = []
    for h in non_noise:
        gid = h.group or "ungrouped"
        if gid not in group_order:
            group_order.append(gid)

    diffs: dict[str, str] = {}
    clusters: list[dict] = []
    for gid in group_order:
        members = [h for h in non_noise if (h.group or "ungrouped") == gid]
        intent = next((h.intent for h in members if h.intent), "") or "(unlabeled change)"

        # A seam is one CORE plus the link(s) that wire it. The core anchors the
        # seam (its `seam` id); links/environment attach to every seam they wire
        # (`wires`) — so a link shared across several cores appears in several
        # seams. That many-to-many is the point: we do NOT partition a link into
        # one seam.
        cores = [h for h in members if h.role == "core"]
        links = [h for h in members if h.role == "link"]
        envs = [h for h in members if h.role == "environment"]

        # Seam ids come from the cores, sorted s1, s2, … so the primary wiring
        # leads rather than file-appearance order surfacing ambient seams first.
        seam_ids: list[str] = []
        for c in cores:
            sid = c.seam or "s0"
            if sid not in seam_ids:
                seam_ids.append(sid)
        seam_ids.sort(key=lambda s: (int(m.group()) if (m := re.search(r"\d+", s)) else 1_000_000, s))
        known = set(seam_ids)
        coreless = not cores

        # (sid, label, hunks, link-hunk-ids) per seam. A core anchors each seam;
        # links/env attach to the seam(s) they wire.
        specs: list[tuple[str, str, list[Hunk], list[str]]] = []
        if cores:
            for sid in seam_ids:
                core_hunks = [c for c in cores if (c.seam or "s0") == sid]
                link_hunks = [l for l in links if sid in l.wires]
                env_hunks = [e for e in envs if sid in e.wires]
                label = next((h.seam_label for h in core_hunks if h.seam_label), "")
                specs.append((sid, label, core_hunks + link_hunks + env_hunks,
                              [l.id for l in link_hunks]))
            # In a cluster that HAS cores, a link/env wiring none of them is
            # genuinely suspect — surface as warned synthetic seams.
            dangling = [l for l in links if not any(s in known for s in l.wires)]
            if dangling:
                specs.append(("s-unwired", "unwired links", dangling, [l.id for l in dangling]))
            ambient = [e for e in envs if not any(s in known for s in e.wires)]
            if ambient:
                specs.append(("s-ambient", "ambient ripple", ambient, []))
        else:
            # CORE-LESS cluster: a legitimate link-only (rewire/redirect) or
            # ambient-only intent — NOT broken. Render as ONE seam labelled by the
            # cluster intent, with a link-only posture (see _verify_pair) instead
            # of splitting into "unwired links" + "ambient ripple" piles with
            # false dangling-link warnings.
            rest = links + envs
            if rest:
                seam_label_txt = (intent if intent and intent != "(unlabeled change)"
                                  else ("link-only changes" if links else "ambient changes"))
                specs.append(("s-rewire" if links else "s-ambient",
                              seam_label_txt, rest, [l.id for l in links]))

        seams: list[dict] = []
        cluster_kinds: dict[str, int] = {}
        for sid, label, seam_hunks, link_ids in specs:
            blocks = _role_blocks(seam_hunks, f"{gid}-{sid}", diffs)
            s_has_core = any(b["role"] == "core" for b in blocks)
            s_has_link = any(b["role"] == "link" for b in blocks)
            verification = _verify_pair(s_has_core, s_has_link, coreless_cluster=coreless)
            for w in verification["warnings"]:
                cluster_kinds[w["kind"]] = cluster_kinds.get(w["kind"], 0) + 1
            # A seam is UNCERTAIN when self-consistency voting was split on its
            # core's role (the model wasn't sure this is a distinct core) — surface
            # it so the reviewer treats the seam as a maybe, not a fact.
            seam_cores = [h for h in seam_hunks if h.role == "core"]
            min_conf = min((h.role_confidence for h in seam_cores), default=1.0)
            uncertain = bool(seam_cores) and min_conf < UNCERTAIN_THRESHOLD
            tested = sid in covered_seams
            untested = s_has_core and not tested  # a core with no test covering it
            seams.append({
                "tested": tested, "untested": untested,
                "id": sid,
                "label": label,
                "blocks": blocks,
                "has_core": s_has_core,
                "has_link": s_has_link,
                "verification": verification,
                "count": len(seam_hunks),
                "link_ids": link_ids,
                "uncertain": uncertain,
                "confidence": round(min_conf, 2),
            })

        # Which other seams each seam shares a link with (a link wiring >1 core) —
        # surfaced in the detail panel so the shared joint is legible.
        link_to_seams: dict[str, list[str]] = {}
        for s in seams:
            for lid in s["link_ids"]:
                link_to_seams.setdefault(lid, []).append(s["id"])
        for s in seams:
            others: list[str] = []
            for lid in s["link_ids"]:
                for sid2 in link_to_seams[lid]:
                    if sid2 != s["id"] and sid2 not in others:
                        others.append(sid2)
            s["shares_with"] = others

        role_pills = [
            {"role": role, "count": sum(1 for h in members if h.role == role)}
            for role in _CLUSTER_ROLES
            if any(h.role == role for h in members)
        ]
        clusters.append({
            "id": gid,
            "intent": intent,
            "seams": seams,
            "n_seams": len(seams),
            "role_pills": role_pills,
            "count": len(members),
            "warnings": _aggregate_warnings(cluster_kinds),
        })

    return clusters, diffs


def _hunk_start_line(h: Hunk) -> int:
    """New-side start line from the @@ header, for ordering hunks within a file."""
    m = re.search(r"\+(\d+)", h.header_line())
    return int(m.group(1)) if m else 0


def _hunk_line_span(h: Hunk) -> tuple[int, int]:
    """(start, end) new-side line range from the @@ header — the lines this hunk
    occupies in the post-change file, for the extension's editor decorations."""
    m = re.search(r"\+(\d+)(?:,(\d+))?", h.header_line())
    if not m:
        return (0, 0)
    start = int(m.group(1))
    count = int(m.group(2)) if m.group(2) else 1
    return (start, start + max(count, 1) - 1)


def _role_blocks(hunks: list[Hunk], key_prefix: str, diffs: dict[str, str]) -> list[dict]:
    """Build a seam's blocks in (file, line) order — one block per hunk, each carrying
    its own role. This puts CLOSE core/link/environment together (a core and the
    same-file link/env that surround it sit adjacent, in code reading order) instead
    of bucketing all cores, then all links, then all env. The model's wiring is only
    seam-granular (no hunk-level "this link wires this core"), so file+line proximity
    is the available 'closeness' signal. Each block's diff is registered under a
    per-hunk key."""
    ordered = sorted(hunks, key=lambda h: (h.file_path, _hunk_start_line(h)))
    blocks: list[dict] = []
    for h in ordered:
        key = f"{key_prefix}-{h.id}"
        diff_str = _merged_diff([h])
        if diff_str.strip():
            diffs[key] = diff_str
        items = _file_items([h])
        whys: list[str] = []
        for it in items:
            for r in it["rationales"]:
                if r not in whys:
                    whys.append(r)
        start, end = _hunk_line_span(h)
        blocks.append({
            "role": h.role,
            "key": key,
            "hid": h.id,
            "file": h.file_path,
            "start": start,
            "end": end,
            "has_diff": bool(diff_str.strip()),
            "items": items,
            "files": [it["file"] for it in items],
            "whys": whys,
            "notes": _notes([h]),
            "count": 1,
        })
    return blocks


def _verify_pair(has_core: bool, has_link: bool, coreless_cluster: bool = False) -> dict:
    """Triangulation check (§3) for one seam — a flag + warning, NOT a re-bucketing.

    A seam IS the core↔link unit, so this is where the check is most natural: we
    flag when one side is absent. We deliberately do NOT claim "impact not in
    diff" — an isolated core may have its consumer in another seam/cluster (the
    tool can't tell without the deferred meta-link detector), so the warning says
    only what it knows: "no link in this seam".

    `coreless_cluster`: the WHOLE cluster has no core. Then this seam is a
    legitimate link-only (rewire/redirect) or ambient-only intent — NOT a broken
    seam. "Dangling link" only means something when a core exists that the link
    failed to reach; with no core in the cluster there is nothing to dangle from.
    So we emit NO warning, just an informational posture.
    """
    if coreless_cluster:
        posture = ("link-only — no new logic in this diff; it wires a core that lives "
                   "elsewhere (existing code, or another change). Verify the connection."
                   if has_link else
                   "ambient only — shared/support changes; trust delegated to the consumer")
        return {"triangulated": False, "link_only": True, "posture": posture, "warnings": []}
    warnings: list[dict] = []
    if has_core and not has_link:
        warnings.append({
            "kind": "isolated-core",
            "text": "isolated core — no link in this seam; verify the consumer "
                    "(may be in another seam/cluster or outside the diff)",
        })
    elif has_link and not has_core:
        warnings.append({
            "kind": "dangling-link",
            "text": "dangling link — no core in this seam; wires to something changed elsewhere",
        })
    elif not has_core and not has_link:
        warnings.append({
            "kind": "delegated",
            "text": "ambient only — no core/link; trust delegated to the consumer",
        })
    return {"triangulated": has_core and has_link, "warnings": warnings}


_WARN_LABELS = {
    "isolated-core": "isolated core",
    "dangling-link": "dangling link",
    "delegated": "ambient only",
}


def _aggregate_warnings(kinds: dict[str, int]) -> list[dict]:
    """Roll seam-level warnings up to one badge per kind for the (collapsed)
    cluster summary, so risk stays visible before you expand."""
    out = []
    for kind, label in _WARN_LABELS.items():
        n = kinds.get(kind, 0)
        if n:
            suffix = " seams" if n > 1 else " seam"
            out.append({"kind": kind, "count": n, "text": f"{n} {label}{suffix}"})
    return out


def _seam_files(seam: dict) -> list[str]:
    """Distinct files touched by a seam, across all its role blocks."""
    files: list[str] = []
    for b in seam["blocks"]:
        for f in b["files"]:
            if f not in files:
                files.append(f)
    return files


def _build_graph(clusters: list[dict], hunk_loc: dict[str, str] | None = None) -> dict:
    """Cytoscape-ready elements: clusters as compound parents, seams as child
    nodes, and two kinds of seam↔seam edge. `hunk_loc` maps a hunk id to its
    "file:line" so wiring edges can name the joint at hunk level.

    - WIRING edges: a single link that wires more than one core joins those
      seams. This is the real many-to-many joint the model keeps — the shared
      link literally stitches two wirings together (intra-cluster, solid).
    - FILE edges (cross-cluster only): two *intents* bound by a shared file —
      the thread you'd cut to ship them apart (dashed). Within a cluster the
      wiring edges already carry the genuine coupling, so we don't add file edges
      there.
    """
    hunk_loc = hunk_loc or {}
    nodes: list[dict] = []
    edges: list[dict] = []
    file_to_nodes: dict[str, list[str]] = {}
    link_to_nodes: dict[str, list[str]] = {}
    node_cluster: dict[str, str] = {}

    for ci, cl in enumerate(clusters):
        color = _CLUSTER_COLORS[ci % len(_CLUSTER_COLORS)]
        cl["color"] = color  # let the template tint the detail panel to match
        nodes.append({"data": {
            "id": cl["id"], "kind": "cluster", "label": cl["intent"], "color": color,
        }})
        for seam in cl["seams"]:
            nid = f'{cl["id"]}-{seam["id"]}'
            warns = seam["verification"]["warnings"]
            files = _seam_files(seam)
            nodes.append({"data": {
                "id": nid,
                "parent": cl["id"],
                "kind": "seam",
                "label": seam["label"] or seam["id"],
                "seam": seam["id"],
                "color": color,
                "count": seam["count"],
                "roles": [b["role"] for b in seam["blocks"]],
                "has_core": seam["has_core"],
                "has_link": seam["has_link"],
                "warn": warns[0]["kind"] if warns else "",
                "uncertain": seam["uncertain"],
                "confidence": seam["confidence"],
                "tested": seam.get("tested", False),
                "untested": seam.get("untested", False),
            }})
            node_cluster[nid] = cl["id"]
            for f in files:
                file_to_nodes.setdefault(f, []).append(nid)
            for lid in seam["link_ids"]:
                link_to_nodes.setdefault(lid, []).append(nid)

    # Wiring edges — one per pair of seams that share a link hunk. We track WHICH
    # link hunk(s) join them (the joint, locatable at hunk level: id + file:line) so
    # the edge view can pinpoint exactly where the two seams are wired together.
    wiring: dict[tuple[str, str], list[str]] = {}
    for lid, nids in link_to_nodes.items():
        uniq = sorted(set(nids))
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                wiring.setdefault((uniq[i], uniq[j]), []).append(lid)
    for (a, b), lids in wiring.items():
        edges.append({"data": {
            "id": f"w-{a}--{b}", "source": a, "target": b,
            "kind": "wiring", "weight": len(lids),
            "wires": [{"id": lid, "loc": hunk_loc.get(lid, "")} for lid in lids],
            "cross": node_cluster[a] != node_cluster[b],
        }})

    # File edges — kept only ACROSS clusters (two intents bound by a shared file).
    pair_files: dict[tuple[str, str], list[str]] = {}
    for f, nids in file_to_nodes.items():
        uniq = sorted(set(nids))
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                a, b = uniq[i], uniq[j]
                if node_cluster[a] != node_cluster[b]:
                    pair_files.setdefault((a, b), []).append(f)
    for (a, b), files in pair_files.items():
        edges.append({"data": {
            "id": f"f-{a}--{b}", "source": a, "target": b,
            "kind": "file", "shared": sorted(files), "weight": len(files),
            "cross": True,
        }})

    return {"nodes": nodes, "edges": edges}


def _hunk_location(h: Hunk) -> str:
    """'file:line' of a hunk — file + the new-side start line from its @@ header."""
    m = re.search(r"\+(\d+)", h.header_line())
    return f"{h.file_path}:{m.group(1)}" if m else h.file_path


def emit_seams_json(hunks: list[Hunk]) -> dict:
    """Structured seam data for the VS Code extension (the native-rendering surface).

    The classification is the shared core; the extension consumes THIS instead of
    the HTML — it paints editor decorations (gutter bar + scrollbar map per seam)
    and a seam tree, with VS Code itself as the renderer. Same cluster/seam assembly
    the report uses (cross-cluster merge, link-only, synthetic seams), but reduced to
    each hunk's file + new-side line range + role. Tests and noise are separate
    groups (skim posture)."""
    from .symbol_edges import external_coupling, external_refs, rewire_pairs
    clusters, _ = _build_clusters(hunks)
    # Per-hunk self-consistency confidence (share of votes agreeing on the shown
    # role). The extension marks a hunk whose role vote was SPLIT as uncertain, so
    # roles near the ~0.8 ceiling read as honest "maybe core/link", not as fact.
    conf = {h.id: round(h.role_confidence, 2) for h in hunks}
    # External coupling: module(s) a hunk wires to that live OUTSIDE the diff (an
    # imported symbol defined nowhere in the change). Surfaced ONLY for UNWIRED
    # link/environment hunks, so an otherwise-blank "unwired link" reads as
    # "→ @coss/ui" — the §I "diff is not the codebase" boundary made legible. A
    # hunk already wired to an in-diff core doesn't need it (and would just be noise).
    _ext_all = external_coupling(hunks)
    _refs_all = external_refs(hunks)
    _relevant = {h.id for h in hunks
                 if h.role in ("link", "environment") and not h.wires and _ext_all.get(h.id)}
    ext = {hid: _ext_all[hid] for hid in _relevant}            # roots, for the label
    refs = {hid: _refs_all.get(hid, []) for hid in _relevant}  # {symbol,source}, for Layer 2 resolve
    # A->B rewire (Layer 1): the §I "re-routes A->B" swap read from the hunk's own
    # -/+ lines (showToast -> toastManager). Only the crisp swaps survive; omitted
    # when absent so the contract stays lean.
    rewire = {hid: r for hid, r in rewire_pairs(hunks).items() if r["removed"] and r["added"]}

    def _hunk(b: dict) -> dict:
        return {"id": b["hid"], "file": b["file"], "start": b["start"],
                "end": b["end"], "role": b["role"],
                "confidence": conf.get(b["hid"], 1.0),
                "external": ext.get(b["hid"], []),
                "externalRefs": refs.get(b["hid"], []),
                "rewire": rewire.get(b["hid"])}

    out_clusters = []
    for ci, cl in enumerate(clusters):
        out_clusters.append({
            "id": cl["id"],
            "intent": cl["intent"],
            "colorIndex": ci,
            "seams": [{
                "id": s["id"],
                "label": s["label"] or s["id"],
                "linkOnly": bool(s["verification"].get("link_only")),
                "uncertain": bool(s.get("uncertain")),
                "warnings": [w["kind"] for w in s["verification"]["warnings"]],
                "hunks": [_hunk(b) for b in s["blocks"]],
            } for s in cl["seams"]],
        })

    def _plain(h: Hunk) -> dict:
        start, end = _hunk_line_span(h)
        return {"id": h.id, "file": h.file_path, "start": start, "end": end,
                "role": h.role, "confidence": round(h.role_confidence, 2),
                "external": ext.get(h.id, []), "externalRefs": refs.get(h.id, []),
                "rewire": rewire.get(h.id)}

    return {
        "clusters": out_clusters,
        "tests": [_plain(h) for h in hunks if h.role == "test"],
        "noise": [_plain(h) for h in hunks if h.role == "noise"],
    }


def render(hunks: list[Hunk], out_path: str, source_label: str = "diff") -> str:
    """Render the report to `out_path`; returns the absolute path written."""
    clusters, diffs = _build_clusters(hunks)
    hunk_loc = {h.id: _hunk_location(h) for h in hunks}
    graph = _build_graph(clusters, hunk_loc)

    noise_hunks = [h for h in hunks if h.role == "noise"]
    noise_diff = _merged_diff(noise_hunks)
    if noise_diff.strip():
        diffs["noise"] = noise_diff
    noise = {
        "hunks": noise_hunks,
        "has_diff": bool(noise_diff.strip()),
        "items": _file_items(noise_hunks),
        "notes": _notes(noise_hunks),
        "count": len(noise_hunks),
    }

    # Tests: skim posture (execution delegated to CI). Surfaced as their own section
    # — not decomposed as seams — with the cores they cover shown via the seams'
    # `tested` flag. The undelegatable signal (untested cores) is on the seams.
    test_hunks = [h for h in hunks if h.role == "test"]
    test_diff = _merged_diff(test_hunks)
    if test_diff.strip():
        diffs["tests"] = test_diff
    tests = {
        "hunks": test_hunks,
        "has_diff": bool(test_diff.strip()),
        "items": _file_items(test_hunks),
        "notes": _notes(test_hunks),
        "count": len(test_hunks),
    }
    untested_cores = sum(1 for cl in clusters for s in cl["seams"] if s.get("untested"))

    counts = {role: sum(1 for h in hunks if h.role == role)
              for role in ("core", "link", "environment", "test", "noise")}
    isolated_cores = sum(
        w["count"] for cl in clusters for w in cl["warnings"]
        if w["kind"] == "isolated-core"
    )

    # JSON destined for a <script> block: escape so it can't break out of the
    # element or be HTML-escaped by autoescape (we mark it |safe in the template).
    def _script_json(obj) -> str:
        return (
            json.dumps(obj)
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("&", "\\u0026")
        )

    diffs_json = _script_json(diffs)
    graph_json = _script_json(graph)

    env = Environment(
        loader=FileSystemLoader(str(_TEMPLATE_DIR)),
        autoescape=select_autoescape(["html", "j2"]),
    )
    template = env.get_template("report.html.j2")
    html = template.render(
        clusters=clusters,
        noise=noise,
        tests=tests,
        counts=counts,
        descriptions=ROLE_DESCRIPTIONS,
        diffs_json=diffs_json,
        graph_json=graph_json,
        total=len(hunks),
        n_clusters=len(clusters),
        isolated_cores=isolated_cores,
        untested_cores=untested_cores,
        source_label=source_label,
    )

    out = Path(out_path).resolve()
    out.write_text(html, encoding="utf-8")
    return str(out)
