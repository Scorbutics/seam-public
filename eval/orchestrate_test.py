"""Tests for P5 LLM auto-orchestration (src/orchestrate.py) — the LLM is mocked (stochastic)."""
import os

import pytest

from src.codebase import orchestrate
from src.codebase.atoms import available

REPO = os.path.join(os.path.dirname(__file__), "fixtures", "scan_repo")
ANCHOR = "packages/lib/payments.ts"
SYM = "PaymentService"


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_done_immediately_returns_seed(monkeypatch):
    monkeypatch.setattr(orchestrate.llm, "run_pass", lambda *a, **k: {"step": {"done": True}})
    data, hist = orchestrate.auto_orchestrate(REPO, ANCHOR, SYM, "how does payment work", max_steps=3)
    assert hist == []                                  # no moves
    assert any(n["symbol"] == SYM for n in data["nodes"])   # but the seed footprint is there


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_applies_a_chosen_move(monkeypatch):
    # the LLM picks a real consumer symbol from the footprint → the loop attempts that expansion
    seq = iter([{"step": {"node": "checkout", "direction": "up", "done": False}}])
    monkeypatch.setattr(orchestrate.llm, "run_pass", lambda *a, **k: next(seq, {"step": {"done": True}}))
    data, hist = orchestrate.auto_orchestrate(REPO, ANCHOR, SYM, "how does checkout pay", max_steps=3)
    assert hist and hist[0]["node"] == "checkout" and hist[0]["direction"] == "up"


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_invalid_node_stops_gracefully(monkeypatch):
    # a hallucinated node (not in the footprint) → no crash, just stops
    monkeypatch.setattr(orchestrate.llm, "run_pass",
                        lambda *a, **k: {"step": {"node": "DoesNotExist", "direction": "up"}})
    data, hist = orchestrate.auto_orchestrate(REPO, ANCHOR, SYM, "x", max_steps=3)
    assert hist == []


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_no_llm_degrades_to_seed(monkeypatch):
    def boom(*a, **k):
        raise orchestrate.llm.LLMError("no backend")
    monkeypatch.setattr(orchestrate.llm, "run_pass", boom)
    data, hist = orchestrate.auto_orchestrate(REPO, ANCHOR, SYM, "x", max_steps=3)
    assert hist == [] and data["nodes"]                # the seed stands; never a crash
