"""Deterministic seam sub-grouping (the altitude mid-level)."""
from __future__ import annotations

from src.diff.subgroup import subgroup_seams


def _seam(sid, label, files, shares=()):
    return {"id": sid, "label": label, "shares_with": list(shares),
            "blocks": [{"file": f} for f in files]}


def test_small_cluster_stays_flat():
    seams = [_seam("s1", "a", ["x/a.ts"]), _seam("s2", "b", ["x/b.ts"]), _seam("s3", "c", ["x/c.ts"])]
    assert subgroup_seams(seams) is None          # below the size guard → flat


def test_large_cluster_splits_by_directory_and_coupling():
    # two clear sub-intents: a coss-ui/shared cluster and an apps/web cluster, each internally
    # coupled (shared links), nothing crossing.
    ui = [_seam(f"u{i}", f"prim {i}", [f"packages/coss-ui/src/shared/p{i}.ts"],
                shares=[f"u{j}" for j in range(4) if j != i]) for i in range(4)]
    web = [_seam(f"w{i}", f"page {i}", [f"apps/web/modules/feat/v{i}.tsx"],
                 shares=[f"w{j}" for j in range(4) if j != i]) for i in range(4)]
    groups = subgroup_seams(ui + web)
    assert groups is not None and len(groups) == 2
    members = sorted(sorted(g["seamIds"]) for g in groups)
    assert members == [["u0", "u1", "u2", "u3"], ["w0", "w1", "w2", "w3"]]
    # the coss-ui group is named by its shared directory tail
    coss = next(g for g in groups if "u0" in g["seamIds"])
    assert "shared" in coss["label"] or "coss-ui" in coss["label"]


def test_one_tight_blob_returns_none():
    # 8 seams, ALL mutually coupled in one directory → no real sub-structure → flat (no fake split).
    blob = [_seam(f"b{i}", f"thing {i}", [f"apps/web/x/f{i}.ts"],
                  shares=[f"b{j}" for j in range(8) if j != i]) for i in range(8)]
    assert subgroup_seams(blob) is None
