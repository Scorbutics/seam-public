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
    non_noise = [h for h in hunks if h.role != "noise"]

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

        # (sid, label, hunks, link-hunk-ids) per seam, then synthetic seams for
        # links/environment that wire no core present in this cluster.
        specs: list[tuple[str, str, list[Hunk], list[str]]] = []
        for sid in seam_ids:
            core_hunks = [c for c in cores if (c.seam or "s0") == sid]
            link_hunks = [l for l in links if sid in l.wires]
            env_hunks = [e for e in envs if sid in e.wires]
            label = next((h.seam_label for h in core_hunks if h.seam_label), "")
            specs.append((sid, label, core_hunks + link_hunks + env_hunks,
                          [l.id for l in link_hunks]))
        dangling = [l for l in links if not any(s in known for s in l.wires)]
        if dangling:
            specs.append(("s-unwired", "unwired links", dangling, [l.id for l in dangling]))
        ambient = [e for e in envs if not any(s in known for s in e.wires)]
        if ambient:
            specs.append(("s-ambient", "ambient ripple", ambient, []))

        seams: list[dict] = []
        cluster_kinds: dict[str, int] = {}
        for sid, label, seam_hunks, link_ids in specs:
            blocks = _role_blocks(seam_hunks, f"{gid}-{sid}", diffs)
            s_has_core = any(b["role"] == "core" for b in blocks)
            s_has_link = any(b["role"] == "link" for b in blocks)
            verification = _verify_pair(s_has_core, s_has_link)
            for w in verification["warnings"]:
                cluster_kinds[w["kind"]] = cluster_kinds.get(w["kind"], 0) + 1
            seams.append({
                "id": sid,
                "label": label,
                "blocks": blocks,
                "has_core": s_has_core,
                "has_link": s_has_link,
                "verification": verification,
                "count": len(seam_hunks),
                "link_ids": link_ids,
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


def _role_blocks(hunks: list[Hunk], key_prefix: str, diffs: dict[str, str]) -> list[dict]:
    """Build the per-role blocks (core → link → environment) for a set of hunks,
    merged per file, and register each block's diff string under `key_prefix`."""
    blocks: list[dict] = []
    for role in _CLUSTER_ROLES:
        role_hunks = [h for h in hunks if h.role == role]
        if not role_hunks:
            continue
        key = f"{key_prefix}-{role}"
        diff_str = _merged_diff(role_hunks)
        if diff_str.strip():
            diffs[key] = diff_str
        items = _file_items(role_hunks)
        whys: list[str] = []
        for it in items:
            for r in it["rationales"]:
                if r not in whys:
                    whys.append(r)
        blocks.append({
            "role": role,
            "key": key,
            "has_diff": bool(diff_str.strip()),
            "items": items,
            "files": [it["file"] for it in items],
            "whys": whys,
            "notes": _notes(role_hunks),
            "count": len(role_hunks),
        })
    return blocks


def _verify_pair(has_core: bool, has_link: bool) -> dict:
    """Triangulation check (§3) for one seam — a flag + warning, NOT a re-bucketing.

    A seam IS the core↔link unit, so this is where the check is most natural: we
    flag when one side is absent. We deliberately do NOT claim "impact not in
    diff" — an isolated core may have its consumer in another seam/cluster (the
    tool can't tell without the deferred meta-link detector), so the warning says
    only what it knows: "no link in this seam".
    """
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


def _build_graph(clusters: list[dict]) -> dict:
    """Cytoscape-ready elements: clusters as compound parents, seams as child
    nodes, and two kinds of seam↔seam edge.

    - WIRING edges: a single link that wires more than one core joins those
      seams. This is the real many-to-many joint the model keeps — the shared
      link literally stitches two wirings together (intra-cluster, solid).
    - FILE edges (cross-cluster only): two *intents* bound by a shared file —
      the thread you'd cut to ship them apart (dashed). Within a cluster the
      wiring edges already carry the genuine coupling, so we don't add file edges
      there.
    """
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
            }})
            node_cluster[nid] = cl["id"]
            for f in files:
                file_to_nodes.setdefault(f, []).append(nid)
            for lid in seam["link_ids"]:
                link_to_nodes.setdefault(lid, []).append(nid)

    # Wiring edges — one per pair of seams that share a link hunk; weight counts
    # how many links they share. A link wiring N cores produces a clique of N
    # seams. These are intra-cluster (a link only wires cores in its own cluster).
    wiring: dict[tuple[str, str], int] = {}
    for nids in link_to_nodes.values():
        uniq = sorted(set(nids))
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                key = (uniq[i], uniq[j])
                wiring[key] = wiring.get(key, 0) + 1
    for (a, b), w in wiring.items():
        edges.append({"data": {
            "id": f"w-{a}--{b}", "source": a, "target": b,
            "kind": "wiring", "weight": w,
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


def render(hunks: list[Hunk], out_path: str, source_label: str = "diff") -> str:
    """Render the report to `out_path`; returns the absolute path written."""
    clusters, diffs = _build_clusters(hunks)
    graph = _build_graph(clusters)

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

    counts = {role: sum(1 for h in hunks if h.role == role)
              for role in ("core", "link", "environment", "noise")}
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
        counts=counts,
        descriptions=ROLE_DESCRIPTIONS,
        diffs_json=diffs_json,
        graph_json=graph_json,
        total=len(hunks),
        n_clusters=len(clusters),
        isolated_cores=isolated_cores,
        source_label=source_label,
    )

    out = Path(out_path).resolve()
    out.write_text(html, encoding="utf-8")
    return str(out)
