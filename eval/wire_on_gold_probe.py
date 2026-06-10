#!/usr/bin/env python3
"""Isolate WIRING quality from ROLE accuracy: impose GOLD roles (cores fixed), then
compare wiring methods. wiring_f1 is otherwise role-dominated (a mis-roled core
breaks all its seam's edges), so we hold roles constant and vary only the wiring.

Methods (all on gold roles):
  - junk-drawer : every non-core wires the FIRST gold core in its cluster (the
                  _reconcile present[0] behaviour).
  - symbol-floor: deterministic core-anchored symbol edges (L4).
  - passC       : the LLM wiring pass (Pass C), N runs.

Run: .venv/bin/python eval/wire_on_gold_probe.py
"""
from __future__ import annotations
import json, statistics, sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src.diff import parser, classifier
from src.diff.symbol_edges import candidate_wirings
from eval.harness import _wiring_edges

CASES = _ROOT / "eval" / "cases"
GOLD = _ROOT / "eval" / "gold"
N = 3


def build(patch: Path, gold: list[dict]):
    g = {h["id"]: h for h in gold}
    hunks = [h for h in parser.parse(patch.read_text()) if h.id in g]
    for h in hunks:
        gd = g[h.id]
        h.role = gd["role"]
        h.group = gd.get("group", "")
        h.intent = gd.get("intent", "")
        h.rationale = gd.get("rationale", "")
        h.seam = h.id if h.role == "core" else ""        # seam IS its core hunk
        h.seam_label = (gd.get("rationale", "")[:48]) if h.role == "core" else ""
        h.wires = []
    return hunks


def junk_drawer(hunks):
    first = {}
    for h in hunks:
        if h.role == "core":
            first.setdefault(h.group, h.id)
    for h in hunks:
        if h.role != "core":
            c = first.get(h.group)
            h.wires = [c] if c else []


def symbol_floor(hunks):
    cands = candidate_wirings(hunks)
    cores = {h.id for h in hunks if h.role == "core"}
    for h in hunks:
        h.wires = [] if h.role == "core" else \
            list(dict.fromkeys(o for o, _ in cands.get(h.id, []) if o in cores))


def wf1(hunks, gold) -> tuple[float, float, float]:
    pe = _wiring_edges([{"id": h.id, "role": h.role, "seam": h.seam,
                         "wires": h.wires} for h in hunks])
    ge = _wiring_edges(gold)
    common = {h.id for h in hunks} & {h["id"] for h in gold}
    pe = {(a, b) for a, b in pe if a in common and b in common}
    ge = {(a, b) for a, b in ge if a in common and b in common}
    tp, fp, fn = len(pe & ge), len(pe - ge), len(ge - pe)
    pr = tp / (tp + fp) if (tp + fp) else 1.0
    rc = tp / (tp + fn) if (tp + fn) else 1.0
    return pr, rc, (2 * pr * rc / (pr + rc) if (pr + rc) else 0.0)


def main() -> int:
    kind, binary = classifier.resolve_backend()
    print(f"{'case':24} {'junk-drawer':>11} {'symbol-floor':>12} {'PASS C (gold roles)':>22}")
    jd_a, sf_a, pc_a = [], [], []
    for patch in sorted(CASES.glob("*.patch")):
        gp = GOLD / f"{patch.stem}.json"
        if not gp.exists():
            continue
        gold = json.loads(gp.read_text())
        h = build(patch, gold); junk_drawer(h); jd = wf1(h, gold)[2]
        h = build(patch, gold); symbol_floor(h); sf = wf1(h, gold)[2]
        pcs = []
        for _ in range(N):
            h = build(patch, gold)
            try:
                classifier._run_wire_pass(h, kind, binary, "claude-haiku-4-5",
                                          verbose=False, debug=False, debug_path=None)
            except classifier.ClassifierError:
                continue  # model refused on a tiny case; skip this run
            pcs.append(wf1(h, gold))
        if not pcs:
            print(f"{patch.stem:24} {jd:11.3f} {sf:12.3f}   (pass C: all runs failed)")
            jd_a.append(jd); sf_a.append(sf)
            continue
        pc = statistics.mean(f for _, _, f in pcs)
        pcp = statistics.mean(p for p, _, _ in pcs)
        pcr = statistics.mean(r for _, r, _ in pcs)
        jd_a.append(jd); sf_a.append(sf); pc_a.append(pc)
        print(f"{patch.stem:24} {jd:11.3f} {sf:12.3f}   {pcp:.2f}/{pcr:.2f}/{pc:.3f}")
    print(f"{'MEAN':24} {statistics.mean(jd_a):11.3f} {statistics.mean(sf_a):12.3f}   "
          f"{'':10}{statistics.mean(pc_a):.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
