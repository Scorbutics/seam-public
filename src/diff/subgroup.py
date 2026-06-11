"""Seam sub-grouping — the ALTITUDE mid-level between cluster and seam.

A big product cluster can hold many seams (cal.com: one 'redesign webhook UI' cluster, 15+
seams) — too high an altitude to review as a flat list. This partitions a cluster's seams into
a few sub-intents by a DETERMINISTIC affinity (coupling via shared links + directory proximity +
label-token overlap), agglomerated with average linkage.

GUARDED, because an unguarded cut over-fragments (an elbow always finds *some* gap — it split the
focused diffs into 2 when they're one intent). So we sub-group ONLY a large cluster, and only when
a real affinity drop exists; a small cluster or one tight blob returns None → rendered flat. The
grouping is STRUCTURAL (not LLM intent), so it never fakes confidence — labels come from the shared
directory or the dominant seam. The reviewer steers altitude by expanding/collapsing these groups.
"""
from __future__ import annotations

import re

# Only sub-group a cluster with MORE than this many seams (every focused diff has fewer — the
# over-fragmentation guard, validated on the case suite).
_MIN_SEAMS = 7
# Stop agglomerating when the best remaining average-linkage affinity drops below this: groups end
# up separated by a genuine gap (weakly coupled), so a tight blob stays whole instead of being split.
_FLOOR = 1.0
# Affinity weights: a shared LINK is the strongest "same sub-intent" signal, then directory, then label.
_W_COUPLING, _W_DIR, _W_LABEL = 1.6, 1.0, 0.8

_STOP = {"the", "and", "for", "with", "new", "view", "update", "add", "setup", "component",
         "components", "ui", "redesign", "management", "refactor"}


def _toks(label: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", (label or "").lower()) if len(t) > 2 and t not in _STOP}


def _features(seam: dict) -> dict:
    """A seam reduced to what the affinity needs: its files' directories, label tokens, the seams it
    shares a link with (coupling), and its size (block count, for naming)."""
    dirs = {tuple(b["file"].split("/")[:-1]) for b in seam["blocks"]}
    return {"label": seam["label"] or seam["id"], "dirs": dirs, "tok": _toks(seam["label"] or ""),
            "shares": set(seam.get("shares_with") or []), "size": len(seam["blocks"])}


def _dir_proximity(da: set, db: set) -> float:
    """Longest shared path prefix (0..1) over any directory pair of the two seams."""
    best = 0.0
    for x in da:
        for y in db:
            k = 0
            for a, b in zip(x, y):
                if a == b:
                    k += 1
                else:
                    break
            best = max(best, k / max(len(x), len(y), 1))
    return best


def _affinity(a: str, b: str, f: dict) -> float:
    A, B = f[a], f[b]
    coup = 1.0 if (b in A["shares"] or a in B["shares"]) else 0.0
    dirp = _dir_proximity(A["dirs"], B["dirs"])
    lab = len(A["tok"] & B["tok"]) / max(1, len(A["tok"] | B["tok"]))
    return _W_COUPLING * coup + _W_DIR * dirp + _W_LABEL * lab


def _hac(ids: list[str], f: dict, floor: float) -> list[list[str]]:
    """Average-linkage agglomeration: merge the closest pair until the best affinity < floor."""
    groups = [[i] for i in ids]

    def group_aff(g1: list[str], g2: list[str]) -> float:
        vals = [_affinity(a, b, f) for a in g1 for b in g2]
        return sum(vals) / len(vals) if vals else 0.0

    while len(groups) > 1:
        best, bi, bj = -1.0, -1, -1
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                v = group_aff(groups[i], groups[j])
                if v > best:
                    best, bi, bj = v, i, j
        if best < floor:
            break
        groups[bi] += groups[bj]
        del groups[bj]
    return groups


# Generic path segments that don't name a feature — skipped when labelling a sub-group by directory.
_GENERIC_DIR = {"src", "components", "component", "view", "views", "shared", "modules", "module",
                "apps", "app", "web", "packages", "package", "lib", "libs", "dialogs", "tabs",
                "pages", "page", "ui", "utils", "common", "core"}


def _name(group: list[str], f: dict) -> str:
    """A STRUCTURAL label for a sub-group: its dominant FEATURE directory segment (the most common
    non-generic path segment across the group's seams — `webhooks`, `coss-ui`), else the biggest
    seam's label. Honest — it's a grouping, not a claimed product intent."""
    from collections import Counter
    seg_freq: Counter = Counter()
    for i in group:
        for d in f[i]["dirs"]:
            for seg in d:
                if seg and seg.lower() not in _GENERIC_DIR:
                    seg_freq[seg] += 1
    if seg_freq:
        return seg_freq.most_common(1)[0][0]
    rep = max(group, key=lambda i: f[i]["size"])
    return f[rep]["label"]


def subgroup_seams(seams: list[dict], *, min_seams: int = _MIN_SEAMS,
                   floor: float = _FLOOR) -> list[dict] | None:
    """Partition a cluster's `seams` (the dicts from `seams._build_clusters`) into sub-intents.
    Returns `[{"label", "seamIds"}]` in first-appearance order, or None when the cluster is small
    (≤ min_seams) or one tight blob (the cut yields a single group) — caller then renders flat.

    The synthetic ambient/unwired seams (`s-ambient`, `s-unwired` — the housekeeping leftovers that
    span every directory) are peeled into their own group rather than smeared across the clustering."""
    if len(seams) <= min_seams:
        return None
    order = [s["id"] for s in seams]
    f = {s["id"]: _features(s) for s in seams}
    synthetic = [s["id"] for s in seams if s["id"].startswith("s-")]
    real = [s["id"] for s in seams if not s["id"].startswith("s-")]
    groups = _hac(real, f, floor) if real else []
    if synthetic:
        groups.append(synthetic)
    if len(groups) <= 1:
        return None
    groups.sort(key=lambda g: min(order.index(i) for i in g))   # preserve cluster reading order
    out = []
    for g in groups:
        if all(i.startswith("s-") for i in g):
            label = "housekeeping"
        elif len(g) == 1:
            label = f[g[0]]["label"]                 # a lone seam is named by itself, not its dir
        else:
            label = _name(g, f)
        out.append({"label": label, "seamIds": sorted(g, key=order.index)})
    return out
