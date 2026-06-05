#!/usr/bin/env python3
"""Contract tests for the facts-provider strategy (src/facts.py).

The provider boundary lets the AST come from any source — regex (today), tree-sitter
(headless/harness), the VS Code editor AST — behind ONE class. The correctness contract
is purely at the output: two providers are equivalent iff they emit equal `HunkFacts`.

`assert_providers_equivalent` is that contract checker. Today it pins
ExternalFactsProvider(from-regex) ≡ RegexFactsProvider (the wire boundary is lossless);
the SAME function will later pin tree-sitter ≡ VS Code on shared fixtures. Run:

    python eval/facts_provider_test.py        # exits non-zero on any mismatch
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src import classifier_det, noise_filter, parser
from src.facts import (ExternalFactsProvider, FACTS_SCHEMA_VERSION, FactsProvider,
                       HunkFacts, MergedFactsProvider, RegexFactsProvider, facts_payload)

CASES = sorted((Path(__file__).resolve().parent / "cases").glob("*.patch"))


def _hunks(case: Path):
    hs = parser.parse(case.read_text(encoding="utf-8"))
    noise_filter.classify(hs)  # marks noise in place
    return hs


def assert_providers_equivalent(p1: FactsProvider, p2: FactsProvider, hunks) -> list:
    """The reusable contract checker: field-by-field HunkFacts equality over the work
    hunks. Returns a list of (hunk_id, facts_p1, facts_p2) mismatches (empty == equal).
    This is how 'tree-sitter must match the VS Code producer' becomes a test."""
    work = [h for h in hunks if h.role != "noise"]
    f1, f2 = p1.facts(work), p2.facts(work)
    return [(h.id, f1.get(h.id), f2.get(h.id)) for h in work if f1.get(h.id) != f2.get(h.id)]


def _classify_json(hunks, **kw) -> str:
    classifier_det.classify(hunks, **kw)
    return parser.hunks_to_json(hunks)


def main() -> int:
    fails = 0
    for case in CASES:
        name = case.stem
        rp = RegexFactsProvider()
        work = [h for h in _hunks(case) if h.role != "noise"]

        # 1. HunkFacts survives the wire contract round-trip (sets <-> sorted lists).
        f = rp.facts(work)
        rt_ok = all(HunkFacts.from_dict(hf.to_dict()) == hf for hf in f.values())
        print(f"  [{'ok ' if rt_ok else 'FAIL'}] {name:30} HunkFacts round-trip")
        fails += not rt_ok

        # 2. ExternalFactsProvider fed the serialized regex facts is EQUIVALENT to regex
        #    (the boundary is lossless — the same assertion will pin tree-sitter≡VS Code).
        payload = facts_payload(work, rp)
        assert payload["version"] == FACTS_SCHEMA_VERSION
        diffs = assert_providers_equivalent(rp, ExternalFactsProvider(payload), _hunks(case))
        print(f"  [{'ok ' if not diffs else 'FAIL'}] {name:30} external ≡ regex facts"
              + (f"  e.g. {diffs[0][0]}" if diffs else ""))
        fails += bool(diffs)

        # 3. End-to-end: classify output is byte-identical through the external boundary.
        a = _classify_json(_hunks(case))
        b = _classify_json(_hunks(case), facts_provider=ExternalFactsProvider(payload))
        e2e_ok = a == b
        print(f"  [{'ok ' if e2e_ok else 'FAIL'}] {name:30} classify end-to-end parity")
        fails += not e2e_ok

        # 4. Partial payload (every other hunk) → regex fallback fills the rest; every
        #    work hunk still gets a role (graceful degradation, no dropped hunks).
        half = {"version": FACTS_SCHEMA_VERSION,
                "hunks": dict(list(payload["hunks"].items())[::2])}
        hs = _hunks(case)
        classifier_det.classify(hs, facts_provider=ExternalFactsProvider(half))
        full_ok = all(h.role for h in hs if h.role != "noise")
        print(f"  [{'ok ' if full_ok else 'FAIL'}] {name:30} partial payload + fallback")
        fails += not full_ok

        # 5. MergedFactsProvider (the VS Code DocumentSymbols path): a partial override of
        #    defines/enclosing changes ONLY those fields on the targeted hunk; all other
        #    fields and all other hunks stay exactly the base's.
        base_f = rp.facts(work)
        target = work[0].id
        other = work[1].id if len(work) > 1 else None
        merge_payload = {"partial": True, "fields": ["defines", "enclosing"],
                         "hunks": {target: {"defines": ["SentinelDef"], "enclosing": ["SentinelEnc"]}}}
        mf = MergedFactsProvider(rp, merge_payload).facts(work)
        merge_ok = (mf[target].defines == {"SentinelDef"}
                    and mf[target].enclosing == {"SentinelEnc"}
                    and mf[target].decisions == base_f[target].decisions      # untouched field
                    and mf[target].references == base_f[target].references
                    and (other is None or mf[other] == base_f[other]))        # untouched hunk
        print(f"  [{'ok ' if merge_ok else 'FAIL'}] {name:30} merged partial override")
        fails += not merge_ok

    print("\n" + "=" * 40)
    print(f"{fails} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
