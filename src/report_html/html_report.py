"""Render decomposed hunks into a single self-contained HTML report.

DEPRECATED — legacy surface. This is the original standalone HTML report; it is
being wound down in favour of the VS Code extension, which renders natively from
`seams.emit_seams_json` (no HTML). New work should target that path. The report
still reuses the shared seam-assembly engine in `src/seams.py` (`_build_clusters`
and the diff helpers) — only the HTML/graph presentation lives here.

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

from .. import ROLE_DESCRIPTIONS
from ..parser import Hunk
from ..seams import _build_clusters, _file_items, _merged_diff, _notes

_TEMPLATE_DIR = Path(__file__).parent / "templates"

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


def render(hunks: list[Hunk], out_path: str, source_label: str = "diff", repo: str | None = None) -> str:
    """Render the report to `out_path`; returns the absolute path written."""
    clusters, diffs = _build_clusters(hunks, repo)
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
