"""The adaptive per-node over-wire prune for the hybrid wiring path."""
from __future__ import annotations

from src.diff.classifier_det import grounded_prune


def test_sparse_node_keeps_all_including_ungrounded():
    # within the gate: every edge survives — the LLM's implicit/border couplings are the point.
    wires = {"a", "b", "c"}
    grounded = {"a"}
    kept, suggested = grounded_prune(wires, grounded, gate=4)
    assert kept == {"a", "b", "c"}
    assert suggested == {"b", "c"}          # ungrounded survivors → faint/LLM


def test_overwired_node_drops_ungrounded():
    # over the gate WITH grounding: drop the topical (ungrounded) edges, keep the grounded.
    wires = {"a", "b", "c", "d", "e", "f"}   # 6 > gate
    grounded = {"a", "b"}
    kept, suggested = grounded_prune(wires, grounded, gate=4)
    assert kept == {"a", "b"}
    assert suggested == set()                # nothing ungrounded survives on a saturated node


def test_overwired_hub_with_no_grounding_is_left_intact():
    # over the gate but NOTHING grounds it → a legitimate barrel/header hub: never emptied.
    wires = {"a", "b", "c", "d", "e"}        # 5 > gate
    grounded: set[str] = set()
    kept, suggested = grounded_prune(wires, grounded, gate=4)
    assert kept == wires                     # untouched (hub protection)
    assert suggested == wires                # all ungrounded → all faint


def test_resolver_confirmed_implicit_edge_survives_on_a_hub():
    # an implicit edge the RESOLVER confirmed counts as grounded → survives even when over-wired.
    wires = {"a", "b", "c", "d", "e", "f"}
    grounded = {"a", "b"}                    # b = a resolver-confirmed implicit coupling
    kept, _ = grounded_prune(wires, grounded, gate=4)
    assert "b" in kept                       # the verified implicit coupling is kept on the hub
