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

from src.codebase import codebase
from src.core import graph_ir


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
    model = codebase.decompose(g)               # F2 intent-seams (a node may be in several)
    health = graph_ir.wellformedness(g)
    gold = json.loads(Path(gold_path).read_text(encoding="utf-8"))

    # node → the seam id(s) it appears in (from the emitted model; many-to-many possible).
    membership: dict[str, set[str]] = {}
    for cl in model["clusters"]:
        for s in cl["seams"]:
            for h in s["hunks"]:
                membership.setdefault(h["id"], set()).add(s["id"])

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

    # ---- seam partition (carrier cores, EXCLUDING the anchor) ----
    # F2 makes the partition many-to-many, but only the ANCHOR core is shared across seams (by
    # construction — it serves every intent); the carrier cores (members) each land in one seam.
    # So we score the CARRIER grouping: exclude the anchor, take each core's (single) seam id.
    gold_seams: dict[str, str] = {n: s for n, s in gold.get("seams", {}).items() if n != g.anchor}
    pred_seams = {nid: sorted(membership[nid])[0] for nid in gold_seams
                  if nid in membership and g.nodes.get(nid) and g.nodes[nid].role == "core"}
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
        # GATED — resolved FACTS: a regression here is real (roles + the honest-gap map).
        "gated": {
            "role_accuracy": round(role_acc, 3) if role_acc is not None else None,
            "role_confusions": [{"gold": gd, "pred": pr} for gd, pr in confusion],
            "role_divergences": role_divergences,
            "shadow": shadow_audit,
        },
        # PROPOSAL — the intent PARTITION is a READING, not a fact: reported for human review,
        # NEVER gated. A different grouping than gold is "a reading to review" (Cause A/B), not a
        # regression. (Even a deterministic partition is a proposal — §0 of the exploration.)
        "proposal": {
            "partition_f1": seam_f1,
            "cause_worklist": cause_pairs,
        },
        "health": health["postures"],
    }


def _print(rep: dict) -> None:
    print(f"\n=== codebase decomposition scorecard | {rep['case']} ===")
    gd = rep["gated"]
    print(f"  [GATED] role accuracy   {gd['role_accuracy']}")
    if gd["role_confusions"]:
        print("          confusions      " + "; ".join(f"{c['gold']}->{c['pred']}" for c in gd["role_confusions"]))
    sa = gd["shadow"]
    print(f"  [GATED] shadow audit    confirmed={sa['confirmed_shadows'] or '—'}  "
          f"suspect_missed_edge={sa['suspect_missed_edges'] or '—'}  "
          f"suspect_over_wired={sa['suspect_over_wired'] or '—'}")
    if gd["role_divergences"]:
        print("          role divergences (audit gold vs engine):")
        for d in gd["role_divergences"]:
            print(f"            - {d['node']}: gold {d['gold']} vs engine {d['pred']}")
    pr = rep["proposal"]
    f = pr["partition_f1"]
    if f is not None:
        print(f"  [proposal] seam partition  F1 {f['f1']}  (precision {f['precision']} recall {f['recall']})"
              "   — a reading to review, NOT gated")
    if pr["cause_worklist"]:
        print("  [proposal] CAUSE A/B worklist (human classifies each — a different reading, not a bug):")
        for c in pr["cause_worklist"]:
            print(f"            - {c['a']} & {c['b']}: engine {c['engine']}, gold {c['gold']} — {c['classify']}")
    print(f"  health          {rep['health']}")


def gate(report: dict, baseline: dict, tol: float = 0.05) -> int:
    """Fail (exit 1) ONLY on a regression in the GATED facts — role accuracy dropping, or more
    suspect-missed-edges (the resolver getting blinder). The PROPOSAL partition is NEVER gated: a
    different intent grouping is a reading to review, not a regression."""
    regressed: list[str] = []
    cg, bg = report["gated"], baseline.get("gated", {})
    if cg["role_accuracy"] is not None and bg.get("role_accuracy") is not None \
            and cg["role_accuracy"] < bg["role_accuracy"] - tol:
        regressed.append(f"role_accuracy {bg['role_accuracy']} -> {cg['role_accuracy']}")
    cm = len(cg["shadow"]["suspect_missed_edges"])
    bm = len(bg.get("shadow", {}).get("suspect_missed_edges", []))
    if cm > bm:
        regressed.append(f"suspect_missed_edges {bm} -> {cm} (resolver blinder)")
    if regressed:
        print("\n❌ REGRESSION (gated facts):")
        for r in regressed:
            print(f"   - {r}")
        return 1
    print("\n✅ no regression in gated facts (partition divergences are proposals, not failures)")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--graph", required=True, help="a ResolvedGraph JSON (the resolver's output)")
    ap.add_argument("--gold", required=True, help="the hand decomposition to score against")
    ap.add_argument("--baseline", help="a saved scorecard JSON; gate on regression in gated facts")
    ap.add_argument("--save", help="write the scorecard JSON here")
    ap.add_argument("--tol", type=float, default=0.05)
    args = ap.parse_args(argv)
    rep = score(args.graph, args.gold)
    _print(rep)
    if args.save:
        Path(args.save).write_text(json.dumps(rep, indent=2), encoding="utf-8")
    if args.baseline:
        return gate(rep, json.loads(Path(args.baseline).read_text(encoding="utf-8")), args.tol)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
