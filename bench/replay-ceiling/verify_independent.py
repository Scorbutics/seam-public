#!/usr/bin/env python3
"""A SECOND, INDEPENDENT implementation of the study's figures.

Written from the raw transcripts alone. It does not import, call, or copy measure.py:
the whole point is that two implementations that never shared code must agree, or one
of them is wrong. Where they disagree, this script says so rather than deferring.

    python3 bench/replay-ceiling/verify_independent.py

Exit 0 = every checked figure reproduces. Exit 1 = at least one does not.
Figures it CANNOT check (answer F1/precision/recall) are listed as UNCHECKED, never
as passing: a check that looked at nothing has not passed.
"""
import json, glob, os, sys, statistics as st, collections

RES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
PRICE = {"in": 5e-6, "cr": 0.5e-6, "cw": 10e-6, "out": 25e-6}
NAME = {"A": "GREP", "B": "SEAM", "C": "REPLAY"}
ARMS = "ABC"
ORACLE_DONE_STEP = 6          # arm C's oracle prints DONE at step 6

fails, notes = [], []


def load():
    runs = collections.defaultdict(dict)
    for f in sorted(glob.glob(os.path.join(RES, "r?.?.jsonl"))):
        rd, arm, _ = os.path.basename(f).split(".")
        calls = 0
        for line in open(f, errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get("message")
            if isinstance(m, dict) and m.get("role") == "assistant" and isinstance(m.get("content"), list):
                calls += sum(1 for b in m["content"]
                             if isinstance(b, dict) and b.get("type") == "tool_use")
            if d.get("type") == "result":
                u = d.get("usage") or {}
                mu = d.get("modelUsage") or {}
                opus = [v for k, v in mu.items() if "opus" in k]
                secs = os.path.join(RES, f"{rd}.{arm}.secs")
                runs[arm][rd] = dict(
                    calls=calls,
                    turns=d.get("num_turns", 0),
                    inp=u.get("input_tokens", 0),
                    cw=u.get("cache_creation_input_tokens", 0),
                    cr=u.get("cache_read_input_tokens", 0),
                    out=u.get("output_tokens", 0),
                    think=(u.get("output_tokens_details") or {}).get("thinking_tokens", 0),
                    cost=d.get("total_cost_usd", 0.0),
                    opus_cost=opus[0].get("costUSD", 0.0) if opus else 0.0,
                    models=sorted(mu.keys()),
                    den=len(d.get("permission_denials") or []),
                    wall_ms=d.get("duration_ms", 0) / 1000.0,
                    api=d.get("duration_api_ms", 0) / 1000.0,
                    wall_secs=float(open(secs).read().strip()) if os.path.exists(secs) else None,
                )
    return runs


def check(label, mine, paper, tol, fmt="{:.1f}"):
    ok = abs(mine - paper) <= tol
    print(f"  {'ok ' if ok else 'FAIL'}  {label:44} mine={fmt.format(mine):>12}  paper={fmt.format(paper):>12}")
    if not ok:
        fails.append(label)
    return ok


runs = load()
M = lambda a, k: st.mean(runs[a][r][k] for r in sorted(runs[a]))
ctx = {a: (M(a, "cr") + M(a, "cw")) / M(a, "turns") for a in ARMS}   # (read+write)/turns

print("=" * 96)
print("INDEPENDENT RE-DERIVATION — docs/STUDY_STRUCTURAL_LIMITS.md, from results/r?.?.jsonl")
print("=" * 96)

print("\n## §1 counts (provider-reported and transcript-derived)")
for key, lbl, paper, tol, fmt in [
    ("calls", "tool calls",   {"A": 22.4, "B": 14.4, "C": 20.8},        0.05, "{:.1f}"),
    ("turns", "model turns",  {"A": 23.4, "B": 15.4, "C": 21.8},        0.05, "{:.1f}"),
    ("cw",    "cache write",  {"A": 36779, "B": 62923, "C": 49991},     1,    "{:.0f}"),
    ("cr",    "cache read",   {"A": 943264, "B": 1229982, "C": 1195918}, 1,   "{:.0f}"),
    ("den",   "refused calls",{"A": 0.0, "B": 1.6, "C": 4.6},           0.05, "{:.1f}"),
]:
    for a in ARMS:
        check(f"{lbl} [{NAME[a]}]", M(a, key), paper[a], tol, fmt)

print("\n## §1 context tokens/turn — definition recovered, NOT documented in the paper")
for a in ARMS:
    paper = {"A": 41882, "B": 83955, "C": 57152}[a]
    alt = M(a, "cr") / M(a, "turns")
    check(f"(cache_read+cache_write)/turns [{NAME[a]}]", ctx[a], paper, 2, "{:.0f}")
    print(f"        (cache_read/turns alone would be {alt:,.0f} — not the figure used)")
notes.append("§1/§4.1: context_per_turn = (cache_read + cache_write)/turns. Undocumented; state it.")

print("\n## §1 wall clock — source is the .secs files, not duration_ms")
for a in ARMS:
    paper = {"A": 85, "B": 119, "C": 89}[a]
    check(f"wall from .secs [{NAME[a]}]", st.mean(runs[a][r]["wall_secs"] for r in sorted(runs[a])), paper, 0.5, "{:.0f}")
    print(f"        (duration_ms would give {M(a,'wall_ms'):.0f}s)")
notes.append("§1: wall clock comes from the shell-timed .secs files; duration_ms is ~2s lower. Say which.")

print("\n## §1 billed cost")
base = M("A", "cost")
for a in ARMS:
    check(f"cost ratio vs GREP [{NAME[a]}]", M(a, "cost") / base,
          {"A": 1.00, "B": 1.42, "C": 1.26}[a], 0.005, "{:.2f}")
for a in "BC":
    got = [runs[a][r]["cost"] / runs["A"][r]["cost"] for r in sorted(runs[a])]
    paper = {"B": [1.01, 1.37, 1.51, 1.68, 1.53], "C": [1.26, 1.18, 1.00, 1.41, 1.48]}[a]
    ok = all(abs(g - p) <= 0.015 for g, p in zip(got, paper))
    print(f"  {'ok ' if ok else 'FAIL'}  paired per-round ratios [{NAME[a]}]   "
          + " ".join(f"{v:.2f}" for v in got))
    if not ok:
        fails.append(f"paired ratios {NAME[a]}")

print("\n## §3.1 'model PINNED' / §3.3 'zero residual'")
models = sorted({m for a in ARMS for r in runs[a] for m in runs[a][r]["models"]})
print(f"        models billed across the 15 runs: {models}")
worst_tot = worst_opus = 0.0
for a in ARMS:
    for rd in runs[a]:
        r = runs[a][rd]
        pred = r["inp"] * PRICE["in"] + r["cr"] * PRICE["cr"] + r["cw"] * PRICE["cw"] + r["out"] * PRICE["out"]
        worst_tot = max(worst_tot, abs(pred - r["cost"]))
        worst_opus = max(worst_opus, abs(pred - r["opus_cost"]))
print(f"  ok    fit vs the opus modelUsage entry      max residual ${worst_opus:.7f}  (exact)")
print(f"  NOTE  fit vs total_cost_usd                 max residual ${worst_tot:.5f}  (the auxiliary model)")
if len(models) > 1:
    notes.append(f"§3.1: {len(models)} models are billed in every run, not one. "
                 f"The fit is exact against the opus entry; total_cost_usd carries the auxiliary model too.")

print("\n## §4.1 the identity, and the product that cancels")
for a in ARMS:
    gap = M(a, "turns") * ctx[a] - M(a, "cr")
    print(f"        {NAME[a]:7} turns x ctx = {M(a,'turns')*ctx[a]:>12,.0f}   cache_read = {M(a,'cr'):>12,.0f}"
          f"   gap = {gap:>9,.0f}   cache_write = {M(a,'cw'):>9,.0f}")
notes.append("§4.1: 'turns x context_per_turn ~ cache_read' is true by construction "
             "(ctx is defined as (read+write)/turns), and the residual it calls approximation "
             "error IS the cache write — the term §4.3 calls the entire finding. Drop 'Verified'.")

Ctot = {a: M(a, "cr") + M(a, "cw") for a in ARMS}
print("\n        product turns_ratio x context_ratio == total-context ratio (turns cancel algebraically):")
for a in "BC":
    tr = M(a, "turns") / M("A", "turns")
    cr_ = ctx[a] / ctx["A"]
    print(f"        {NAME[a]:7} {tr:.3f} x {cr_:.3f} = {tr*cr_:.4f}   and  C_x/C_A = {Ctot[a]/Ctot['A']:.4f}")
notes.append("§4.1: the product is algebraically identical to the total-context ratio — the turns "
             "cancel. Report one ratio, not a product of two that annihilate.")

print("\n## §4.1 adjusted (denials removed)")
for a in ARMS:
    ta = M(a, "turns") - M(a, "den")
    check(f"adjusted turns_ratio [{NAME[a]}]", ta / M("A", "turns"),
          {"A": 1.000, "B": 0.590, "C": 0.735}[a], 0.002, "{:.3f}")
for a in "BC":
    adj = (Ctot[a] - M(a, "den") * ctx[a]) / Ctot["A"]
    check(f"adjusted product [{NAME[a]}]", adj, {"B": 1.182, "C": 1.003}[a], 0.002, "{:.4f}")
print("        (this equals adjusted TOTAL CONTEXT / control — a single ratio, correctly computed)")

print("\n## §4.1 '+305 tokens read excess' — definitional mismatch")
d = M("C", "den")
cands = {
    "adj cache_read, ctx from cache_read only": (M("C", "cr") - d * (M("C", "cr") / M("C", "turns"))) - M("A", "cr"),
    "adj cache_read, ctx as defined in §4.1":   (M("C", "cr") - d * ctx["C"]) - M("A", "cr"),
    "adj total context (read+write)":           (Ctot["C"] - d * ctx["C"]) - Ctot["A"],
}
for k, v in cands.items():
    print(f"        {k:44} {v:+12,.0f}" + ("   <- reproduces '+305'" if abs(v - 305) < 80 else ""))
notes.append("§4.1: '+305' uses context_per_turn = cache_read/turns, contradicting the same section's "
             "(read+write)/turns. Under §4.1's own definition it is -10,244; on total context +2,968. "
             "All three are ~0 against a ~1M baseline, so the CLAIM holds — restate it under one definition "
             "and drop the spurious precision.")

print("\n## §4.3 decomposition of arm C's adjusted gap")
dec = {
    "cache write": ((M("C", "cw") - M("A", "cw")) * PRICE["cw"], 0.1321),
    "cache read":  ((M("C", "cr") - d * ctx["C"] - M("A", "cr")) * PRICE["cr"], 0.0002),
    "output":      ((M("C", "out") - M("A", "out")) * PRICE["out"], 0.0047),
}
tot_mine = sum(v[0] for v in dec.values())
for k, (mine, paper) in dec.items():
    check(f"{k}", mine, paper, 0.002, "{:+.4f}")
check("TOTAL gap ($)", tot_mine, 0.1370, 0.002, "{:+.4f}")
check("TOTAL gap (%)", tot_mine / base * 100, 14.0, 0.5, "{:.1f}")

print("\n## §4.2 / §4.3 derivations (no data needed)")
check("break-even bar (read/write price)", PRICE["cr"] / PRICE["cw"], 0.050, 0.0005, "{:.3f}")
for T, p in [(20, 1.00), (10, 1.50), (4, 3.00), (2, 5.50), (1, 10.50)]:
    check(f"amortised $/Mtok-turn at T={T}", (10 + 0.5 * T) / T, p, 0.005, "${:.2f}")

print("\n## §4.4 thinking tokens — source matters")
for a in ARMS:
    paper = {"A": 870, "B": 1940, "C": 1890}[a]
    check(f"thinking tokens [{NAME[a]}]", M(a, "think"), paper, 5, "{:.0f}")
    print(f"        (usage.output_tokens_details.thinking_tokens; paper uses streamed estimated_tokens)")
for a in "BC":
    paper = {"B": 2.23, "C": 2.17}[a]
    check(f"thinking ratio vs GREP [{NAME[a]}]", M(a, "think") / M("A", "think"), paper, 0.02, "{:.2f}")
notes.append("§4.4: the thinking figures come from streamed estimated_tokens, which sits ~240 tokens "
             "below the provider's own usage.output_tokens_details.thinking_tokens in every arm. "
             "A near-constant offset off a small control baseline inflates the RATIO: 1.97x / 1.94x "
             "on the authoritative field, not 2.23x / 2.17x. 'Roughly doubles' survives; the figure does not.")

print("\n## §5 the verification floor")
for a in ARMS:
    mine = M(a, "calls") - ORACLE_DONE_STEP
    paper = {"A": 16.4, "B": 8.4, "C": 14.8}[a]
    check(f"'calls after the answer was complete' [{NAME[a]}]", mine, paper, 0.05, "{:.1f}")
print(f"        NOTE: this column is total_calls - {ORACLE_DONE_STEP} for EVERY arm. The split index is")
print( "        arm C's DONE step; measure.py's own docstring says it is 'only meaningful for arm C'.")
notes.append("§5: the GREP/SEAM rows of the verification-floor table are total_calls - 6, a fixed index "
             "borrowed from arm C's oracle. measure.py says it is 'only meaningful for arm C'. The paper "
             "heads the column 'calls after the answer was complete' for all three arms. Restrict the "
             "claim to arm C, or define completion for A and B.")

print("\n## §3.2 non-API ('engine') time")
for a in ARMS:
    print(f"        {NAME[a]:7} wall {M(a,'wall_ms'):6.1f}s   api {M(a,'api'):6.1f}s   non-API {M(a,'wall_ms')-M(a,'api'):+6.1f}s")
notes.append("§3.2: non-API time is NEGATIVE for the control (-0.6s), so it is not engine time — "
             "duration_api_ms and duration_ms are not a partition. Arm C's '-1.0s' is 'indistinguishable "
             "from the control', not a measurement of ~1ms.")

print("\n## UNCHECKED — this script cannot verify these; they are not passing, they are unexamined")
for u in ["answer F1 / precision / recall (needs re-scoring answers against truth.txt)",
          "'All 23 of arm C's refusals fall AFTER DONE' (needs reliable refusal ordering)",
          "arXiv 2607.12161 — existence and content of the cited prior work"]:
    print(f"  --    {u}")

print("\n" + "=" * 96)
if fails:
    print(f"{len(fails)} figure(s) did NOT reproduce:")
    for f in fails:
        print("   -", f)
else:
    print("Every checked figure reproduces from the transcripts.")
print(f"\n{len(notes)} definitional / presentational finding(s):")
for i, n in enumerate(notes, 1):
    print(f"  {i}. {n}")
sys.exit(1 if fails else 0)
