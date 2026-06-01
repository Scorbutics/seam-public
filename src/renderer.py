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

        # Seams within the cluster (first-appearance order). Each seam is one
        # core↔link wiring; role blocks live inside it so a core sits next to
        # the link that wires it.
        seam_order: list[str] = []
        for h in members:
            sid = h.seam or "s0"
            if sid not in seam_order:
                seam_order.append(sid)
        # Order seams by their id (s1, s2, …) so the primary wiring leads, rather
        # than by file-appearance order which would surface ambient seams first.
        seam_order.sort(key=lambda s: (int(m.group()) if (m := re.search(r"\d+", s)) else 1_000_000, s))

        seams: list[dict] = []
        cluster_kinds: dict[str, int] = {}
        for sid in seam_order:
            seam_hunks = [h for h in members if (h.seam or "s0") == sid]
            label = next((h.seam_label for h in seam_hunks if h.seam_label), "")
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
            })

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


def render(hunks: list[Hunk], out_path: str, source_label: str = "diff") -> str:
    """Render the report to `out_path`; returns the absolute path written."""
    clusters, diffs = _build_clusters(hunks)

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
    diffs_json = (
        json.dumps(diffs)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )

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
        total=len(hunks),
        n_clusters=len(clusters),
        isolated_cores=isolated_cores,
        source_label=source_label,
    )

    out = Path(out_path).resolve()
    out.write_text(html, encoding="utf-8")
    return str(out)
