"""Codebase validation-harness gate (plan §5). Pins that the measuring stick itself is
correct: it scores a matching gold at 1.0 AND it actually SURFACES divergences (so a future
real-codebase gold mismatch can't pass silently). The harness reports; the human classifies.

    .venv/bin/python -m pytest eval/codebase_harness_test.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from eval import codebase_harness  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
GOLD = Path(__file__).resolve().parent / "gold_codebase"
GRAPH = str(FIXTURES / "resolved-graph-sample.json")


def test_matching_gold_scores_perfect():
    rep = codebase_harness.score(GRAPH, str(GOLD / "resolved-graph-sample.json"))
    assert rep["roles"]["accuracy"] == 1.0
    assert rep["roles"]["divergences"] == []
    assert rep["seams"]["partition_f1"]["f1"] == 1.0
    assert rep["seams"]["cause_worklist"] == []
    # the DI-wired validate is a CONFIRMED shadow (engine + gold agree it's isolated).
    assert rep["shadow_audit"]["confirmed_shadows"] == ["n8"]
    assert rep["shadow_audit"]["suspect_missed_edges"] == []


def test_divergent_gold_is_surfaced(tmp_path):
    # A human who believes validate (n8) BELONGS with the payment seam and is NOT isolated.
    divergent = {
        "roles": {"n1": "core", "n2": "core", "n3": "core", "n8": "core",
                  "n4": "link", "n6": "environment", "n7": "test"},
        "seams": {"n1": "s_class", "n2": "s_pay", "n3": "s_pay", "n8": "s_pay"},
        "warnings": {},
    }
    gp = tmp_path / "divergent.json"
    gp.write_text(json.dumps(divergent), encoding="utf-8")
    rep = codebase_harness.score(GRAPH, str(gp))

    # roles still match; the disagreement is purely about GRAIN + the shadow.
    assert rep["roles"]["accuracy"] == 1.0
    assert rep["seams"]["partition_f1"]["f1"] < 1.0          # partition disagreement detected
    # n8-vs-payment pairs land on the Cause A/B worklist for the human to classify.
    pairs = {tuple(sorted((c["a"], c["b"]))) for c in rep["seams"]["cause_worklist"]}
    assert ("n2", "n8") in pairs and ("n3", "n8") in pairs
    # the engine isolated n8 but the gold didn't → flagged as a SUSPECT missed edge (the
    # exact "true shadow vs missed edge" call §5 asks a human to make — here: the DI edge).
    assert rep["shadow_audit"]["suspect_missed_edges"] == ["n8"]
    assert rep["shadow_audit"]["confirmed_shadows"] == []
