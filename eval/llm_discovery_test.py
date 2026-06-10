"""Tier-3 of the edge ladder — LLM discovery → SUGGESTED, hermetic (the LLM is injected/mocked).

Locks the two invariants: proposals are GROUNDED to real repo paths (hallucinations dropped), and
SUGGESTED stays OUT of the resolved `edges[]` (a blind-spot candidate only). No backend needed."""
from __future__ import annotations

import os

from src.codebase import import_scan, llm_discovery

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "dispatch_repo")


def test_discover_grounds_real_target_and_drops_hallucination():
    def fake(prompt, **kw):
        return {"c1": {"target": "my-handler", "evidence": "loadModule('my-handler')"},   # grounds
                "c2": {"target": "does-not-exist-xyz", "evidence": "x"}}                    # dropped
    cands = llm_discovery.discover(FIX, "caller.ts", "function go(){}", 0, 0, [], run=fake)
    assert [c["file"].replace("\\", "/") for c in cands] == ["handlers/my-handler/index.ts"]
    assert cands[0]["provenance"] == "SUGGESTED"


def test_discover_excludes_already_resolved():
    def fake(prompt, **kw):
        return {"c1": {"target": "my-handler", "evidence": "e"}}
    # if tier 1/2 already resolved that file, tier 3 must not re-propose it
    cands = llm_discovery.discover(FIX, "caller.ts", "function go(){}", 0, 0,
                                   ["handlers/my-handler/index.ts"], run=fake)
    assert cands == []


def test_discover_degrades_on_llm_failure():
    def boom(*a, **k):
        raise llm_discovery.llm.LLMError("no backend")
    assert llm_discovery.discover(FIX, "caller.ts", "x", 0, 0, [], run=boom) == []


def test_tier3_wires_into_dependency_graph_as_suggested_blindspot(monkeypatch):
    monkeypatch.setattr(llm_discovery, "discover", lambda *a, **k: [
        {"file": "handlers/my-handler/index.ts", "evidence": "dynamic", "provenance": "SUGGESTED"}])
    g = import_scan.build_dependency_graph(FIX, "caller.ts", "go", use_llm=True)
    spots = [b for b in g["blindspots"] if b["mechanism"] == "llm-suggested-coupling"]
    assert len(spots) == 1
    assert spots[0]["candidates"][0]["provenance"] == "SUGGESTED"
    # THE INVARIANT: a SUGGESTED proposal never enters the resolved spine.
    assert all(e["provenance"] != "SUGGESTED" for e in g["edges"])


def test_tier3_is_opt_in():
    called = {"n": 0}
    import src.codebase.llm_discovery as ld
    orig = ld.discover
    try:
        ld.discover = lambda *a, **k: called.__setitem__("n", called["n"] + 1) or []
        import_scan.build_dependency_graph(FIX, "caller.ts", "go")            # use_llm defaults False
        assert called["n"] == 0                                              # tier 3 not run
    finally:
        ld.discover = orig
