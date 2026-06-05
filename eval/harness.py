#!/usr/bin/env python3
"""Classification reliability harness — the regression gate for the classifier.

The classifier is an LLM and is NOT deterministic (measured: Haiku swung 1->3
cores, and even Sonnet swung, on byte-identical input). So we cannot trust any
single run, and a naive before/after diff of one run is meaningless. This harness
makes reliability measurable:

  GENERATE (expensive, LLM)  — run each case diff N times, cache every run.
  SCORE    (cheap, pure)     — from the cached runs compute two SEPARATE things:

    * STABILITY  (no gold needed): how much does the output wobble run-to-run?
        per-hunk role agreement, core/seam/cluster count spread. This alone
        catches "my prompt edit made the model flakier".
    * ACCURACY   (needs eval/gold/<case>.json): how close is the output to a
        human-agreed decomposition? role accuracy + confusion, and a
        PERMUTATION-INVARIANT clustering F1 (group ids g1/g2 are arbitrary, so we
        compare PARTITIONS via same-cluster pairs, not label strings).

Workflow:
    python eval/harness.py generate --runs 5 --model claude-haiku-4-5
    python eval/harness.py score    --model claude-haiku-4-5
    python eval/harness.py score --model claude-haiku-4-5 --save eval/baseline.json
    # after a change:
    python eval/harness.py score --model claude-haiku-4-5 --baseline eval/baseline.json
        -> exits non-zero if a metric regressed beyond tolerance.

Because the signal is noisy, the gate works on N-run AGGREGATES with tolerance
bands, never single-run exact match.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from itertools import combinations
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

CASES_DIR = Path(__file__).resolve().parent / "cases"
GOLD_DIR = Path(__file__).resolve().parent / "gold"
RUNS_DIR = Path(__file__).resolve().parent / "_runs"


# ----------------------------------------------------------------------------- generate
def _cases(only: str | None) -> list[Path]:
    cases = sorted(CASES_DIR.glob("*.patch"))
    if only:
        cases = [c for c in cases if c.stem == only]
        if not cases:
            sys.exit(f"no case named {only!r} in {CASES_DIR}")
    return cases


def generate(args) -> int:
    from src import classifier, noise_filter, parser  # local import: LLM path only
    model_dir = RUNS_DIR / (args.label or args.model)
    for case in _cases(args.case):
        out_dir = model_dir / case.stem
        out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(1, args.runs + 1):
            dest = out_dir / f"run_{i}.json"
            if dest.exists() and not args.force:
                print(f"[skip] {case.stem} run {i} (cached)")
                continue
            hunks = parser.parse(case.read_text(encoding="utf-8"))
            remaining = noise_filter.classify(hunks)
            classifier.classify(remaining, model=args.model)
            dest.write_text(parser.hunks_to_json(hunks), encoding="utf-8")
            print(f"[ok]   {case.stem} run {i} -> {dest.relative_to(_ROOT)}")
    return 0


# ----------------------------------------------------------------------------- helpers
def _effective_role(h: dict) -> str:
    """Role used for scoring. We trust the FLAT `role` field: it is the canonical,
    post-processed value the renderer/report use (kept in sync from spans at
    classify time, and the only field updated by the seam post-processing). Reading
    role/seam back out of `spans` is wrong after post-processing — the spans keep
    stale ids."""
    return h.get("role", "")


def _seam_key(h: dict) -> tuple[str, str] | None:
    if h.get("role") != "core":
        return None
    seam = h.get("seam", "")
    return (h.get("group", ""), seam) if seam else None


def _counts(run: list[dict]) -> dict:
    cores = [h for h in run if _effective_role(h) == "core"]
    seams = {k for h in cores if (k := _seam_key(h))}
    clusters = {h.get("group", "") for h in run if _effective_role(h) != "noise" and h.get("group")}
    return {"cores": len(cores), "seams": len(seams), "clusters": len(clusters)}


def _structure_health(run: list[dict]) -> dict:
    """The 'is this an acceptable visualization' signals — what would make a
    reviewer distrust the report, independent of per-hunk label nitpicks:
      - seams: total core seams (watch for explosion)
      - isolated_cores: core seams with NO link wiring them -> a lonely-core warning
      - dangling_links: links wiring no present core -> a dangling-link warning
      - orphans: non-noise hunks left ungrouped (no cluster) -> floating in the UI
    A core<->link blur INSIDE a seam doesn't show up here (it renders adjacent
    anyway); only structure-breaking errors do. Compared to gold, the gap here is
    the 'spurious warning' rate that erodes trust."""
    core_seams: dict[str, set] = {}
    links: dict[str, list] = {}
    orphans = 0
    for h in run:
        role = _effective_role(h)
        if role == "noise":
            continue
        g = h.get("group", "")
        if not g:
            orphans += 1
            continue
        if role == "core":
            sk = _seam_key(h)
            if sk:
                core_seams.setdefault(g, set()).add(sk[1])
        elif role in ("link", "environment"):
            links.setdefault(g, []).append((role, set(h.get("wires") or [])))
    seams = sum(len(s) for s in core_seams.values())
    isolated = 0
    for g, ss in core_seams.items():
        wired = {w for role, ws in links.get(g, []) if role == "link" for w in ws}
        isolated += sum(1 for s in ss if s not in wired)
    dangling = 0
    for g, lst in links.items():
        cs = core_seams.get(g, set())
        dangling += sum(1 for role, ws in lst if role == "link" and not (ws & cs))
    return {"seams": seams, "isolated_cores": isolated,
            "dangling_links": dangling, "orphans": orphans}


def _load_runs(label: str, case: str) -> list[list[dict]]:
    d = RUNS_DIR / label / case
    return [json.loads(p.read_text()) for p in sorted(d.glob("run_*.json"))]


def _pairwise_f1(pred_groups: dict[str, str], gold_groups: dict[str, str]) -> dict:
    """Same-cluster pairwise P/R/F1 over the hunks present in BOTH. Permutation-
    invariant: compares which pairs share a cluster, not the arbitrary group ids."""
    ids = sorted(set(pred_groups) & set(gold_groups))
    tp = fp = fn = 0
    for a, b in combinations(ids, 2):
        same_pred = pred_groups[a] == pred_groups[b]
        same_gold = gold_groups[a] == gold_groups[b]
        if same_pred and same_gold:
            tp += 1
        elif same_pred and not same_gold:
            fp += 1
        elif not same_pred and same_gold:
            fn += 1
    prec = tp / (tp + fp) if (tp + fp) else 1.0
    rec = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return {"precision": prec, "recall": rec, "f1": f1}


def _wiring_edges(hunks: list[dict]) -> set[tuple[str, str]]:
    """The seam wiring as a set of (link_hunk_id -> core_hunk_id) edges.

    A link's `wires` lists arbitrary seam ids; we resolve each seam id to the
    CORE HUNK(S) that anchor it (seam ids are globally unique, so resolve across
    the whole run). Reducing to stable hunk-id pairs makes the comparison
    permutation-invariant over seam labels — same trick as the cluster pairwise
    F1, applied to the bipartite link->core wiring instead of the core partition.
    A hunk wiring SEVERAL seams yields one edge per target core (many-to-many)."""
    seam_to_cores: dict[str, set[str]] = {}
    for h in hunks:
        if h.get("role") == "core" and h.get("seam"):
            seam_to_cores.setdefault(h["seam"], set()).add(h["id"])
    edges: set[tuple[str, str]] = set()
    for h in hunks:
        if h.get("role") == "core":
            continue
        for s in (h.get("wires") or []):
            for core in seam_to_cores.get(s, ()):
                if core != h["id"]:
                    edges.add((h["id"], core))
    return edges


def _wiring_f1(runs: list[list[dict]], gold: list[dict]) -> float | None:
    """Mean per-run F1 of the link->core wiring edge set vs gold. Restricted to the
    hunk universe present in BOTH so it isn't penalised for split/missing hunks.

    NB: this is END-TO-END — a link wired to a hunk pred wrongly thinks is core is
    a real wiring error and counts here, so role errors that break wiring DO show
    up (that is what the renderer shows). The junk-drawer failure — collapsing a
    multi-seam wiring onto one dominant core — shows as low precision AND recall."""
    gold_edges = _wiring_edges(gold)
    f1s = []
    for run in runs:
        common = {h["id"] for h in run} & {h["id"] for h in gold}
        ge = {(a, b) for a, b in gold_edges if a in common and b in common}
        pe = {(a, b) for a, b in _wiring_edges(run) if a in common and b in common}
        tp, fp, fn = len(ge & pe), len(pe - ge), len(ge - pe)
        prec = tp / (tp + fp) if (tp + fp) else 1.0
        rec = tp / (tp + fn) if (tp + fn) else 1.0
        f1s.append(2 * prec * rec / (prec + rec) if (prec + rec) else 0.0)
    return round(statistics.mean(f1s), 3) if f1s else None


# ----------------------------------------------------------------------------- score
def _stability(runs: list[list[dict]]) -> dict:
    n = len(runs)
    # per-hunk role agreement = modal-role share, averaged over hunks
    by_id: dict[str, list[str]] = {}
    for run in runs:
        for h in run:
            by_id.setdefault(h["id"], []).append(_effective_role(h))
    agreements = []
    flips = []
    for hid, roles in by_id.items():
        modal = max(set(roles), key=roles.count)
        agreements.append(roles.count(modal) / len(roles))
        if len(set(roles)) > 1:
            flips.append(hid)
    counts = [_counts(r) for r in runs]

    def spread(key):
        vals = [c[key] for c in counts]
        return {"min": min(vals), "max": max(vals),
                "mean": round(statistics.mean(vals), 2),
                "stdev": round(statistics.pstdev(vals), 2) if n > 1 else 0.0}

    return {
        "runs": n,
        "role_agreement": round(statistics.mean(agreements), 3) if agreements else 1.0,
        "unstable_hunks": flips,
        "cores": spread("cores"), "seams": spread("seams"), "clusters": spread("clusters"),
    }


def _accuracy(runs: list[list[dict]], gold: list[dict]) -> dict:
    gold_role = {h["id"]: _effective_role(h) for h in gold}
    gold_group = {h["id"]: h.get("group", "") for h in gold}
    accs, f1s = [], []
    confusion: dict[tuple[str, str], int] = {}
    for run in runs:
        pred_role = {h["id"]: _effective_role(h) for h in run}
        pred_group = {h["id"]: h.get("group", "") for h in run}
        ids = [i for i in gold_role if i in pred_role]
        if ids:
            accs.append(sum(pred_role[i] == gold_role[i] for i in ids) / len(ids))
        for i in ids:
            confusion[(gold_role[i], pred_role[i])] = confusion.get((gold_role[i], pred_role[i]), 0) + 1
        f1s.append(_pairwise_f1(pred_group, gold_group)["f1"])
    conf = [{"gold": g, "pred": p, "n": n} for (g, p), n in sorted(confusion.items()) if g != p]
    return {
        "role_accuracy": round(statistics.mean(accs), 3) if accs else None,
        "cluster_f1": round(statistics.mean(f1s), 3) if f1s else None,
        "wiring_f1": _wiring_f1(runs, gold),
        "confusions": conf,
    }


def score(args) -> int:
    label = args.label or args.model
    report = {"model": args.model, "label": label, "cases": {}}
    for case in _cases(args.case):
        runs = _load_runs(label, case.stem)
        if not runs:
            print(f"[warn] no runs for {case.stem} (run `generate` first)")
            continue
        entry = {"stability": _stability(runs)}
        # Visualization health: mean over runs, vs gold (the spurious-warning gap).
        hkeys = ("seams", "isolated_cores", "dangling_links", "orphans")
        hs = [_structure_health(r) for r in runs]
        entry["health"] = {k: round(statistics.mean(h[k] for h in hs), 2) for k in hkeys}
        gold_path = GOLD_DIR / f"{case.stem}.json"
        if gold_path.exists():
            gold = json.loads(gold_path.read_text())
            entry["accuracy"] = _accuracy(runs, gold)
            entry["health_gold"] = {k: _structure_health(gold)[k] for k in hkeys}
        report["cases"][case.stem] = entry

    _print_report(report)

    if args.save:
        Path(args.save).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nsaved scorecard -> {args.save}")

    if args.baseline:
        return _gate(report, json.loads(Path(args.baseline).read_text()), args.tol)
    return 0


def _print_report(report: dict) -> None:
    print(f"\n=== reliability scorecard | model={report['model']} ===")
    for name, e in report["cases"].items():
        s = e["stability"]
        print(f"\n{name}  ({s['runs']} runs)")
        print(f"  role agreement   {s['role_agreement']:.0%}   "
              f"unstable hunks: {', '.join(s['unstable_hunks']) or 'none'}")
        for k in ("cores", "seams", "clusters"):
            v = s[k]
            print(f"  {k:<9} min={v['min']} max={v['max']} mean={v['mean']} stdev={v['stdev']}")
        if "accuracy" in e:
            a = e["accuracy"]
            print(f"  role accuracy    {a['role_accuracy']}   cluster F1 {a['cluster_f1']}   wiring F1 {a.get('wiring_f1')}")
            if a["confusions"]:
                cs = "; ".join(f"{c['gold']}->{c['pred']}×{c['n']}" for c in a["confusions"])
                print(f"  confusions       {cs}")
        else:
            print("  (no gold labels — accuracy skipped; add eval/gold/%s.json)" % name)
        if "health" in e:
            h = e["health"]
            hg = e.get("health_gold")
            gtxt = (f"  (gold: seams={hg['seams']} iso={hg['isolated_cores']} "
                    f"dangling={hg['dangling_links']} orphans={hg['orphans']})") if hg else ""
            print(f"  health           seams={h['seams']} isolated_cores={h['isolated_cores']} "
                  f"dangling_links={h['dangling_links']} orphans={h['orphans']}{gtxt}")


def _gate(report: dict, baseline: dict, tol: float) -> int:
    """Fail (exit 1) if any case's accuracy/stability dropped beyond `tol`."""
    regressed = []
    for name, e in report["cases"].items():
        b = baseline.get("cases", {}).get(name)
        if not b:
            continue
        cur_s, base_s = e["stability"], b["stability"]
        if cur_s["role_agreement"] < base_s["role_agreement"] - tol:
            regressed.append(f"{name}: role_agreement {base_s['role_agreement']:.3f} -> {cur_s['role_agreement']:.3f}")
        if "accuracy" in e and "accuracy" in b:
            for key in ("role_accuracy", "cluster_f1", "wiring_f1"):
                cur, base = e["accuracy"].get(key), b["accuracy"].get(key)
                if cur is not None and base is not None and cur < base - tol:
                    regressed.append(f"{name}: {key} {base:.3f} -> {cur:.3f}")
    if regressed:
        print(f"\n❌ REGRESSION (tol={tol}):")
        for r in regressed:
            print(f"   - {r}")
        return 1
    print(f"\n✅ no regression beyond tol={tol}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="run the classifier N times per case and cache the runs")
    g.add_argument("--runs", type=int, default=5)
    g.add_argument("--model", default="claude-haiku-4-5")
    g.add_argument("--label", help="run-set dir name (default: model). Use to keep "
                   "prompt/config variants from colliding, e.g. --label haiku-sharp-roles")
    g.add_argument("--case", help="only this case (filename stem)")
    g.add_argument("--force", action="store_true", help="re-generate even if cached")
    g.set_defaults(func=generate)

    s = sub.add_parser("score", help="score cached runs (stability always; accuracy if gold exists)")
    s.add_argument("--model", default="claude-haiku-4-5")
    s.add_argument("--label", help="run-set dir name to score (default: model)")
    s.add_argument("--case", help="only this case (filename stem)")
    s.add_argument("--save", help="write the scorecard JSON here (e.g. a new baseline)")
    s.add_argument("--baseline", help="compare against this scorecard and gate on regression")
    s.add_argument("--tol", type=float, default=0.05, help="regression tolerance band (default 0.05)")
    s.set_defaults(func=score)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
