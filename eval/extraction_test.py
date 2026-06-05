#!/usr/bin/env python3
"""Deterministic extraction gate — the regression test for the NON-LLM signals.

External coupling and the A->B rewire are PURE functions of the diff text, so they
are tested by EXACT assertion against a hand-labeled gold (eval/extraction_gold.json),
not by the stochastic reliability harness (which is for LLM output). Run before/after
any change to symbol_edges so a "smarter" extractor can't silently regress.

    .venv/bin/python eval/extraction_test.py     # exits non-zero on any failure

`rewire` is the Layer 1 target: if symbol_edges has no `rewire_pairs` yet, those
cases report PENDING (not failure) — build it until they go green.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import symbol_edges  # noqa: E402

GOLD = Path(__file__).resolve().parent / "extraction_gold.json"


class _H:
    """Minimal hunk: symbol_edges only reads .id and .text."""
    def __init__(self, hid: str, text: str):
        self.id, self.text = hid, text


def _norm(d: dict) -> dict:
    return {"removed": sorted(d.get("removed", [])), "added": sorted(d.get("added", []))}


def main() -> int:
    gold = json.loads(GOLD.read_text())
    fails, pending = 0, 0

    print("=== external coupling ===")
    for c in gold["external_cases"]:
        h = _H(c["hunk"], c["text"])
        got = sorted(symbol_edges.external_coupling([h]).get(c["hunk"], []))
        exp = sorted(c["expect"])
        ok = got == exp
        # resolution symbols (Layer 2 input): assert the (deterministic) symbol list
        if "expect_ref_symbols" in c:
            got_sym = sorted(r["symbol"] for r in symbol_edges.external_refs([h]).get(c["hunk"], []))
            exp_sym = sorted(c["expect_ref_symbols"])
            if got_sym != exp_sym:
                ok = False
                print(f"       refs: expect={exp_sym} got={got_sym}")
        fails += not ok
        print(f"  [{'ok ' if ok else 'FAIL'}] {c['id']:20} roots={got}")

    print("=== A->B rewire (Layer 1) ===")
    rewire_fn = getattr(symbol_edges, "rewire_pairs", None)
    if rewire_fn is None:
        pending = len(gold["rewire_cases"])
        print(f"  PENDING — symbol_edges.rewire_pairs not implemented ({pending} cases waiting)")
    else:
        for c in gold["rewire_cases"]:
            got = _norm(rewire_fn([_H(c["hunk"], c["text"])]).get(c["hunk"], {}))
            exp = _norm(c["expect"])
            ok = got == exp
            fails += not ok
            print(f"  [{'ok ' if ok else 'FAIL'}] {c['id']:20} expect={exp} got={got}")

    print("=== link span-segmentation by core (§B) ===")
    for c in gold.get("segment_cases", []):
        link = _H(c["id"], c["link_text"])
        core_defs = {cid: set(syms) for cid, syms in c["core_defs"].items()}
        seg = symbol_edges.segment_link_by_core(link, core_defs)
        located = sorted(seg.keys())
        exp = sorted(c["expect_located"])
        # the first-located core (by earliest line) should be the expected one
        first = min(seg, key=lambda cid: seg[cid][0][0]) if seg else None
        ok = located == exp and first == c["expect_first_core"]
        fails += not ok
        ranges = {cid: rs for cid, rs in seg.items()}
        print(f"  [{'ok ' if ok else 'FAIL'}] {c['id']:20} located={located} first={first}")
        if not ok:
            print(f"       expect located={exp} first={c['expect_first_core']}; ranges={ranges}")

    print("=== alias resolution (filesystem resolver) ===")
    for c in gold.get("resolve_cases", []):
        got = symbol_edges.resolve_alias(set(c["used"]),
                                         {k: set(v) for k, v in c["cores"].items()}, c["file"])
        got = {k: sorted(v) for k, v in got.items()}
        exp = {k: sorted(v) for k, v in c["expect"].items()}
        ok = got == exp
        fails += not ok
        print(f"  [{'ok ' if ok else 'FAIL'}] {c['id']:30} expect={exp} got={got}")

    print(f"\n{'='*40}\n{fails} failure(s)" + (f", {pending} pending" if pending else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
