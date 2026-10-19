#!/usr/bin/env python3
"""Arm E (the minimal-payload oracle) against arms A and C, run together on one rig.

    python3 bench/replay-ceiling/results-min-payload/compare.py

Question: arm C's oracle is optimal on latency, order and recall, but it serves Seam's ~13k-token output. Does
the ceiling still hold when the payload is as small as it can be — only the answer, one step, then DONE?
Only comparisons inside this directory are paired; the published rounds ran on another machine.
"""
import json, glob, os, sys, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import contextlib, io
with contextlib.redirect_stdout(io.StringIO()):            # measure.py prints its whole report on import
    from measure import measure, score, truth_files      # answer scoring only; everything else is read here

P = {"in": 5e-6, "cr": 0.5e-6, "cw": 10e-6, "out": 25e-6}  # opus, fitted exactly in verify_independent.py
NAME = {"A": "GREP", "C": "REPLAY", "E": "REPLAY-MIN"}
SEARCH = {"rg", "grep", "egrep", "fgrep", "ag", "ack", "fd"}

def verbs(cmd):
    out = []
    for seg in (cmd or "").replace("&&", "|").replace("||", "|").replace(";", "|").split("|"):
        w = seg.split()
        if w and w[0] != "cd": out.append(os.path.basename(w[0]))
    return out

def run(path, arm):
    calls, done_at, res = [], None, None
    for line in open(path, errors="replace"):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get("message")
        if isinstance(m, dict) and isinstance(m.get("content"), list):
            for b in m["content"]:
                if not isinstance(b, dict): continue
                if m.get("role") == "assistant" and b.get("type") == "tool_use":
                    calls.append((b["id"], b.get("name", ""), (b.get("input") or {}).get("command", "")))
                elif m.get("role") == "user" and b.get("type") == "tool_result" and done_at is None:
                    c = b.get("content"); t = c if isinstance(c, str) else json.dumps(c)
                    if "DONE" in t: done_at = len(calls)
        if d.get("type") == "result": res = d
    if res is None: return None
    refused = {x.get("tool_use_id") for x in res.get("permission_denials") or []}
    granted = sum(1 for i, n, c in calls if i in refused and not
                  (arm in "CE" and (n in ("Grep", "Glob") or any(v in SEARCH for v in verbs(c)))))
    u = res.get("usage") or {}
    cr, cw, turns = u.get("cache_read_input_tokens", 0), u.get("cache_creation_input_tokens", 0), res.get("num_turns", 0)
    cost = res.get("total_cost_usd", 0.0)
    after = calls[done_at:] if done_at is not None else []
    s = score(measure(path), truth_files())
    return dict(calls=len(calls), turns=turns, done=done_at, refused=len(refused), granted_refused=granted,
                after=len(after), after_ran=sum(1 for i, _, _ in after if i not in refused),
                cw=cw, ctx=cr + cw, cost=cost,
                cost_adj=cost - len(refused) * ((cr + cw) / turns if turns else 0) * P["cr"],
                prec=s["prec"], rec=s["rec"], f1=s["f1"])

rounds = sorted({os.path.basename(f).split(".")[0] for f in glob.glob(os.path.join(HERE, "e?.A.jsonl"))})
R = {a: {} for a in "ACE"}
for rd in rounds:
    for a in "ACE":
        f = os.path.join(HERE, f"{rd}.{a}.jsonl")
        r = run(f, a) if os.path.exists(f) else None
        if r: R[a][rd] = r
paired = [rd for rd in rounds if all(rd in R[a] for a in "ACE")]
if not paired:
    print("no complete round yet"); sys.exit(0)
M = lambda a, k: st.mean(R[a][rd][k] for rd in paired)

print(f"paired rounds: {paired}   (n={len(paired)})\n")
rows = [("tool calls", "calls", "{:.1f}"), ("model turns", "turns", "{:.1f}"), ("refused", "refused", "{:.1f}"),
        ("cache write", "cw", "{:,.0f}"), ("total input ctx", "ctx", "{:,.0f}"), ("billed cost $", "cost", "{:.3f}"),
        ("answer precision", "prec", "{:.2f}"), ("answer recall", "rec", "{:.2f}"), ("answer F1", "f1", "{:.2f}")]
print(f"{'':26}" + "".join(f"{NAME[a]:>14}" for a in "ACE"))
for label, k, fmt in rows:
    print(f"{label:26}" + "".join(f"{fmt.format(M(a, k)):>14}" for a in "ACE"))

print("\n## after the oracle said DONE")
for a in "CE":
    print(f"  {NAME[a]:11} DONE at {[R[a][rd]['done'] for rd in paired]}   after {[R[a][rd]['after'] for rd in paired]}"
          f"   ran {[R[a][rd]['after_ran'] for rd in paired]}  mean {M(a, 'after_ran'):.1f}")

print("\n## apparatus")
bad = sum(R[a][rd]["granted_refused"] for a in "ACE" for rd in paired)
print("  " + ("clean — no granted verb refused" if bad == 0 else f"FAILED — {bad} granted verb(s) refused"))

print("\n## paired, per round")
for lbl, a, b, k in [("cost vs GREP, raw", "C", "A", "cost"), ("cost vs GREP, raw", "E", "A", "cost"),
                     ("cost vs GREP, adjusted", "C", "A", "cost_adj"), ("cost vs GREP, adjusted", "E", "A", "cost_adj"),
                     ("total ctx vs GREP", "E", "A", "ctx"), ("cost vs REPLAY, raw", "E", "C", "cost")]:
    v = [R[a][rd][k] / R[b][rd]["cost" if k.startswith("cost") else k] for rd in paired]
    print(f"  {lbl:24} {NAME[a]:11} " + " ".join(f"{x:.2f}" for x in v) + f"   mean {st.mean(v):.3f}")
d = [R["C"][rd]["cost"] - R["E"][rd]["cost"] for rd in paired]
if len(d) > 1 and st.stdev(d) > 0:
    print(f"  cost C minus E per round ${[round(x, 3) for x in d]}  paired t = {st.mean(d) / (st.stdev(d) / len(d) ** .5):.2f} (df={len(d) - 1})")
e = [R["E"][rd]["cost"] / R["A"][rd]["cost"] for rd in paired]
if len(e) > 1:
    print(f"  E/A: sd {st.stdev(e):.2f}; above 1.0 in {sum(x > 1.01 for x in e)}, level in "
          f"{sum(abs(x - 1) <= 0.01 for x in e)}, below in {sum(x < 0.99 for x in e)}")
