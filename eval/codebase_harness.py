#!/usr/bin/env python3
"""Codebase-mode validation harness — the §5 manual-validation protocol, mechanised.

The §6 gate ("does this HELP someone build a mental map?") can only be answered on real
codebases via the extension (F5). What CAN be pinned offline is whether the decomposition
is HONEST AND CORRECT — the precondition for asking whether it helps. This harness scores
a `ResolvedGraph` decomposition against a hand-written GOLD and surfaces every divergence
in the §5 vocabulary, so the human classifies (it does not pretend to judge for them):

  - ROLE accuracy + confusion (anchor-relative core/link/environment/test).
  - SEAM partition F1 — permutation-invariant (same-seam pairs over cores, like the diff
    harness's cluster F1): is the GRAIN right, independent of arbitrary seam ids?
  - SHADOW audit (the differentiator, plan §5): for every malformed seam, is it a TRUE
    shadow (gold agrees it's isolated) or a MISSED EDGE (a resolver gap to fix)? And the
    converse — an isolated-core the engine WIRED but gold left isolated (possible over-wire).
  - DIVERGENCE list with the Cause A / Cause B prompt (plan §8.3): a seam mis-cut the engine
    could repair (A) vs genuine entanglement the engine was right not to cut (B). The harness
    LISTS them; the human assigns the cause.

GOLD format (eval/gold_codebase/<case>.json):
    { "roles":   {"n1":"core", "n4":"link", ...},          # per node
      "seams":   {"n1":"sA", "n2":"sB", "n3":"sB", ...},   # CORES → a hand seam id
      "warnings":{"n8":["isolated-core"]} }                # optional, for the shadow audit

    python eval/codebase_harness.py --graph eval/fixtures/<g>.json --gold eval/gold_codebase/<g>.json
"""
from __future__ import annotations

import argparse
import json
import sys
from itertools import combinations
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src import codebase, graph_ir  # noqa: E402


def _pairwise_f1(pred: dict[str, str], gold: dict[str, str]) -> dict:
    """Same-group pairwise P/R/F1 over ids in BOTH — permutation-invariant (compares which
    pairs share a seam, not the arbitrary seam ids). Mirrors the diff harness's cluster F1."""
    ids = sorted(set(pred) & set(gold))
    tp = fp = fn = 0
    for a, b in combinations(ids, 2):
        sp, sg = pred[a] == pred[b], gold[a] == gold[b]
        if sp and sg:
            tp += 1
        elif sp and not sg:
            fp += 1
        elif sg and not sp:
            fn += 1
    prec = tp / (tp + fp) if (tp + fp) else 1.0
    rec = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return {"precision": round(prec, 3), "recall": round(rec, 3), "f1": round(f1, 3)}


def score(graph_path: str, gold_path: str) -> dict:
    """Decompose the ResolvedGraph and score it against the gold. Pure — returns a dict."""
    g = graph_ir.from_resolved_graph(json.loads(Path(graph_path).read_text(encoding="utf-8")))
    codebase.decompose(g)                       # mutates g with roles/clusters/seams
    health = graph_ir.wellformedness(g)
    gold = json.loads(Path(gold_path).read_text(encoding="utf-8"))

    # ---- roles ----
    gold_roles: dict[str, str] = gold.get("roles", {})
    pred_roles = {nid: g.nodes[nid].role for nid in gold_roles if nid in g.nodes}
    role_ids = [nid for nid in gold_roles if nid in pred_roles]
    role_acc = (sum(pred_roles[i] == gold_roles[i] for i in role_ids) / len(role_ids)
                if role_ids else None)
    confusion = sorted({(gold_roles[i], pred_roles[i]) for i in role_ids
                        if gold_roles[i] != pred_roles[i]})
    role_divergences = [{"node": i, "gold": gold_roles[i], "pred": pred_roles[i]}
                        for i in role_ids if gold_roles[i] != pred_roles[i]]

    # ---- seam partition (cores only) ----
    gold_seams: dict[str, str] = gold.get("seams", {})
    pred_seams = {nid: g.nodes[nid].seam for nid in gold_seams
                  if nid in g.nodes and g.nodes[nid].role == "core"}
    seam_f1 = _pairwise_f1(pred_seams, gold_seams) if gold_seams else None
    # the Cause A/B work-list: core PAIRS the engine and gold disagree on grouping for.
    cause_pairs = []
    common = sorted(set(pred_seams) & set(gold_seams))
    for a, b in combinations(common, 2):
        sp, sg = pred_seams[a] == pred_seams[b], gold_seams[a] == gold_seams[b]
        if sp != sg:
            cause_pairs.append({"a": a, "b": b,
                                "engine": "together" if sp else "apart",
                                "gold": "together" if sg else "apart",
                                "classify": "Cause A (mis-cut, repairable)? or Cause B (truly entangled)?"})

    # ---- shadow audit (true shadow vs missed edge) ----
    pred_iso = {c for c, ws in health["seam_warnings"].items() if "isolated-core" in ws}
    gold_iso = {n for n, ws in gold.get("warnings", {}).items() if "isolated-core" in ws}
    shadow_audit = {
        "confirmed_shadows": sorted(pred_iso & gold_iso),                 # honest blind spots
        "suspect_missed_edges": sorted(pred_iso - gold_iso),             # engine isolated, gold didn't → resolver gap?
        "suspect_over_wired": sorted(gold_iso - pred_iso),               # gold isolated, engine wired → over-wire?
    }

    return {
        "case": Path(graph_path).stem,
        "roles": {"accuracy": round(role_acc, 3) if role_acc is not None else None,
                  "confusions": [{"gold": gd, "pred": pr} for gd, pr in confusion],
                  "divergences": role_divergences},
        "seams": {"partition_f1": seam_f1, "cause_worklist": cause_pairs},
        "shadow_audit": shadow_audit,
        "health": health["postures"],
    }


def _print(rep: dict) -> None:
    print(f"\n=== codebase decomposition scorecard | {rep['case']} ===")
    r = rep["roles"]
    print(f"  role accuracy    {r['accuracy']}")
    if r["confusions"]:
        print("  confusions       " + "; ".join(f"{c['gold']}->{c['pred']}" for c in r["confusions"]))
    s = rep["seams"]
    if s["partition_f1"] is not None:
        f = s["partition_f1"]
        print(f"  seam partition   F1 {f['f1']}  (precision {f['precision']} recall {f['recall']})")
    sa = rep["shadow_audit"]
    print(f"  shadow audit     confirmed={sa['confirmed_shadows'] or '—'}  "
          f"suspect_missed_edge={sa['suspect_missed_edges'] or '—'}  "
          f"suspect_over_wired={sa['suspect_over_wired'] or '—'}")
    if s["cause_worklist"]:
        print("  CAUSE A/B worklist (human classifies each):")
        for c in s["cause_worklist"]:
            print(f"    - {c['a']} & {c['b']}: engine {c['engine']}, gold {c['gold']} — {c['classify']}")
    if r["divergences"]:
        print("  role divergences (audit gold vs engine before trusting either):")
        for d in r["divergences"]:
            print(f"    - {d['node']}: gold {d['gold']} vs engine {d['pred']}")
    print(f"  health           {rep['health']}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--graph", required=True, help="a ResolvedGraph JSON (the resolver's output)")
    ap.add_argument("--gold", required=True, help="the hand decomposition to score against")
    args = ap.parse_args(argv)
    _print(score(args.graph, args.gold))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
