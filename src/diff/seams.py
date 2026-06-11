"""Seam-assembly engine: turn classified hunks into intent clusters and seams.

Primary axis is the INTENT CLUSTER, not the role — this is what makes the view
triangulate (§3): inside one cluster you see the core and the links that wire it
in, adjacent, so "links tell you where to expect cores" and the self-check
("why is this core linked *here*?") has something to fire against.

Within a cluster, hunks are grouped into seams (one core + the links that wire
it) in (file, line) order. This module is presentation-agnostic: it produces the
seam structure that the consumers render. The live consumer is `emit_seams_json`,
the structured feed the VS Code extension paints natively. The legacy
self-contained HTML report (`src/report_html/`, deprecated) is the other consumer
and reuses the same `_build_clusters` engine.
"""

from __future__ import annotations

import re

from .parser import Hunk

# Order roles within a cluster so the core is read first, then its links.
_CLUSTER_ROLES = ("core", "link", "environment")

# A seam whose core got LESS than this share of the self-consistency votes is shown
# as "uncertain" — the model was genuinely split on whether it's a distinct core.
UNCERTAIN_THRESHOLD = 0.6


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


def _build_clusters(hunks: list[Hunk], repo: str | None = None) -> tuple[list[dict], dict[str, str]]:
    """Assemble intent clusters and the diff strings they reference.

    Returns (clusters, diffs) where each cluster has role blocks, and `diffs`
    maps a diff key (e.g. "g1-core") to its unified-diff string.
    """
    # Tests are NOT part of a seam's logic — they COVER cores (skim posture). They
    # are kept out of the seam decomposition (so they don't hub the wiring) and
    # surfaced separately, with the seams they cover marked tested.
    covered_seams = {w for h in hunks if h.role == "test" for w in h.wires}
    # Span decomposition: split a big link into per-core sub-ranges so each shows
    # only in the seam it wires (§B), instead of the whole block in every seam.
    # `core_span_map` is the OVERLAP case: a core that references sibling cores is also
    # placed (as a link sub-range) into each sibling's seam — its meaning is seam-dependent.
    # Both are READ from the engine's placements (classifier_det.assign_spans), not computed.
    span_map, core_span_map = _span_map(hunks)
    non_noise = [h for h in hunks if h.role not in ("noise", "test")]
    # Link/env hunks across ALL clusters — a precisely-located span may cross into
    # another cluster's seam (a webhook render's AppHeader region belongs in the
    # app-header seam even though they were clustered apart). Only LOCATED spans
    # cross; a vague whole-hunk cross-cluster wire stays put.
    all_splittable = [h for h in non_noise if h.role in ("link", "environment")]
    # Cores across ALL clusters — a core whose body references a sibling core is placed
    # into that sibling's seam as a LINK sub-range (overlap), even across clusters.
    all_cores = [h for h in non_noise if h.role == "core"]

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

        # (sid, label, hunks, link-hunk-ids, role_for) per seam. A core anchors each
        # seam; links/env attach to the seam(s) they wire. `role_for` overrides a hunk's
        # rendered role for THIS seam (a core placed in a SIBLING seam renders as a link).
        specs: list[tuple[str, str, list[Hunk], list[str], dict[str, str]]] = []
        if cores:
            for sid in seam_ids:
                core_hunks = [c for c in cores if (c.seam or "s0") == sid]
                link_hunks = [l for l in links if sid in l.wires]
                env_hunks = [e for e in envs if sid in e.wires]
                role_for: dict[str, str] = {}
                # Cross-cluster: pull in a link/env from ANOTHER cluster only when it
                # has a PRECISELY-LOCATED span for this seam's core (the AppHeader
                # region of a webhook render → the app-header seam). Renders as that
                # span, in its own role's bucket.
                here = {h.id for h in core_hunks + link_hunks + env_hunks}
                for h2 in all_splittable:
                    if h2.id not in here and sid in span_map.get(h2.id, {}):
                        (link_hunks if h2.role == "link" else env_hunks).append(h2)
                        here.add(h2.id)
                # OVERLAP (§B): a sibling CORE whose body references THIS seam's core is
                # placed here as a LINK sub-range (the region rendering this seam's
                # component). It stays core in its OWN seam — meaning is seam-dependent.
                for c2 in all_cores:
                    if c2.id in here:
                        continue
                    if (c2.seam or "s0") != sid and sid in core_span_map.get(c2.id, {}):
                        link_hunks.append(c2)
                        role_for[c2.id] = "link"
                        here.add(c2.id)
                label = next((h.seam_label for h in core_hunks if h.seam_label), "")
                specs.append((sid, label, core_hunks + link_hunks + env_hunks,
                              [l.id for l in link_hunks], role_for))
            # In a cluster that HAS cores, a link/env wiring none of them is
            # genuinely suspect — surface as warned synthetic seams.
            dangling = [l for l in links if not any(s in known for s in l.wires)]
            if dangling:
                specs.append(("s-unwired", "unwired links", dangling, [l.id for l in dangling], {}))
            ambient = [e for e in envs if not any(s in known for s in e.wires)]
            if ambient:
                specs.append(("s-ambient", "ambient ripple", ambient, [], {}))
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
                              seam_label_txt, rest, [l.id for l in links], {}))

        seams: list[dict] = []
        cluster_kinds: dict[str, int] = {}
        for sid, label, seam_hunks, link_ids, role_for in specs:
            blocks = _role_blocks(seam_hunks, f"{gid}-{sid}", diffs, sid, span_map,
                                  role_for=role_for, core_span_map=core_span_map)
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


def _span_map(hunks: list[Hunk]) -> tuple[
        dict[str, dict[str, tuple[int, int]]], dict[str, dict[str, tuple[int, int]]]]:
    """READ the engine-computed `placements` (classifier_det.assign_spans) into the two
    per-(hunk,seam) maps the seam assembly consumes — pure presentation, no computation:

      - link_spans — a non-core hunk (LINK/ENVIRONMENT) split into the per-core region
        wiring each core it touches.
      - core_spans — a CORE placed as a LINK sub-range into a SIBLING core's seam (the
        OVERLAP: meaning is seam-dependent — core in its own seam, link in the sibling's).

    Both are {hunk_id: {seam_id: (file_start, file_end)}}. The leading-ambient header peel
    (a placement with seam=="") is read separately by `_role_blocks`."""
    link_spans: dict[str, dict[str, tuple[int, int]]] = {}
    core_spans: dict[str, dict[str, tuple[int, int]]] = {}
    for h in hunks:
        for p in h.placements:
            if not p.seam:
                continue  # the header peel — handled in _role_blocks
            dst = core_spans if h.role == "core" else link_spans
            dst.setdefault(h.id, {})[p.seam] = (p.start, p.end)
    return link_spans, core_spans


def _role_blocks(hunks: list[Hunk], key_prefix: str, diffs: dict[str, str],
                 sid: str | None = None,
                 span_map: dict[str, dict[str, tuple[int, int]]] | None = None,
                 role_for: dict[str, str] | None = None,
                 core_span_map: dict[str, dict[str, tuple[int, int]]] | None = None) -> list[dict]:
    """Build a seam's blocks in (file, line) order — one block per hunk, each carrying
    its own role. This puts CLOSE core/link/environment together (a core and the
    same-file link/env that surround it sit adjacent, in code reading order) instead
    of bucketing all cores, then all links, then all env. The model's wiring is only
    seam-granular (no hunk-level "this link wires this core"), so file+line proximity
    is the available 'closeness' signal. Each block's diff is registered under a
    per-hunk key.

    `role_for` overrides a hunk's rendered role for THIS seam (a core placed in a sibling
    seam renders as a `link`). `core_span_map` supplies the sub-range for such a placed
    core. When a hunk is placed WHOLE (no sub-range) and opens with an import/declaration
    header, that header is peeled into its own `environment` block (the §SPANS import-peel)
    — read from the engine's `placements` (seam=="") so the leading imports don't read as
    part of the logic below."""
    role_for = role_for or {}
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
        eff_role = role_for.get(h.id, h.role)

        def _block(role: str, start: int, end: int, bkey: str) -> dict:
            return {
                "role": role, "key": bkey, "hid": h.id, "file": h.file_path,
                "start": start, "end": end, "has_diff": bool(diff_str.strip()),
                "items": items, "files": [it["file"] for it in items],
                "whys": whys, "notes": _notes([h]), "count": 1,
            }

        # Span-level placement: a hunk split by grounding shows only the sub-range that
        # wires THIS seam's core (§B) — from the link map, or the core→sibling map when a
        # core is placed (as a link) into a sibling seam.
        span = None
        if sid:
            span = ((span_map or {}).get(h.id, {}).get(sid)
                    or (core_span_map or {}).get(h.id, {}).get(sid))
        if span:
            blocks.append(_block(eff_role, span[0], span[1], key))
            continue

        # Import-peel (§SPANS): a whole-placed hunk whose engine `placements` carry a header
        # peel (seam=="") splits into an `environment` block (the header) + its real role
        # (the logic below it, from the header's end to the hunk's end).
        full_start, full_end = _hunk_line_span(h)
        peel = next((p for p in h.placements if not p.seam), None)
        if peel and eff_role in ("core", "link") and peel.end < full_end:
            blocks.append(_block("environment", peel.start, peel.end, f"{key}-env"))
            blocks.append(_block(eff_role, peel.end + 1, full_end, key))
            continue
        blocks.append(_block(eff_role, full_start, full_end, key))
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


def emit_seams_json(hunks: list[Hunk], repo: str | None = None,
                    blast_radius: bool = False) -> dict:
    """Structured seam data for the VS Code extension (the native-rendering surface).

    The classification is the shared core; the extension consumes THIS instead of
    the HTML — it paints editor decorations (gutter bar + scrollbar map per seam)
    and a seam tree, with VS Code itself as the renderer. Same cluster/seam assembly
    the report uses (cross-cluster merge, link-only, synthetic seams), but reduced to
    each hunk's file + new-side line range + role. Tests and noise are separate
    groups (skim posture).

    `blast_radius` (needs `repo`): also attach each hunk's `consumers` — who, OUTSIDE the
    diff, imports a symbol this hunk defines (resolved/suggested). Additive; the field is
    omitted entirely when off so the existing contract is unchanged."""
    from .symbol_edges import external_coupling, external_refs, rewire_pairs
    cons = {}
    if blast_radius and repo:
        from .blast_radius import consumers_for
        cons = consumers_for(hunks, repo)
    clusters, _ = _build_clusters(hunks, repo)
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
        d = {"id": b["hid"], "file": b["file"], "start": b["start"],
             "end": b["end"], "role": b["role"],
             "confidence": conf.get(b["hid"], 1.0),
             "external": ext.get(b["hid"], []),
             "externalRefs": refs.get(b["hid"], []),
             "rewire": rewire.get(b["hid"])}
        if cons:
            d["consumers"] = cons.get(b["hid"], [])
        return d

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
        d = {"id": h.id, "file": h.file_path, "start": start, "end": end,
             "role": h.role, "confidence": round(h.role_confidence, 2),
             "external": ext.get(h.id, []), "externalRefs": refs.get(h.id, []),
             "rewire": rewire.get(h.id)}
        if cons:
            d["consumers"] = cons.get(h.id, [])
        return d

    return {
        "clusters": out_clusters,
        "tests": [_plain(h) for h in hunks if h.role == "test"],
        "noise": [_plain(h) for h in hunks if h.role == "noise"],
    }
