#!/usr/bin/env python3
"""Arm D (oracle + grep) against arms A and C, run together on one rig.

    python3 bench/replay-ceiling/results-oracle-grep/compare.py

Question: of arm C's 14.8 calls after DONE, how much is the URGE to verify and how much is
the PRICE of verifying with nothing to query and no search? Arm D is arm C plus grep. Only
comparisons inside this directory are paired; the published rounds ran on another machine
against an older keycloak checkout and are shown for orientation only.
"""
import json, glob, os, re, statistics as st, collections, sys

HERE = os.path.dirname(os.path.abspath(__file__))
P = {"in": 5e-6, "cr": 0.5e-6, "cw": 10e-6, "out": 25e-6}      # opus, fitted exactly in verify_independent.py
NAME = {"A": "GREP", "C": "REPLAY", "D": "REPLAY+grep"}

SEARCH_VERBS = ("rg", "grep", "egrep")
READ_VERBS = ("sed", "cat", "head", "tail", "awk", "wc")

def kind(name, inp):
    """A call is a SEARCH if any command in it searches, so `sed … && grep …` is a search: it runs one.
    Otherwise it is a READ if any command reads a file, a LIST for ls/find, else OTHER."""
    if name == "Bash":
        c = (inp.get("command") or "").strip()
        if "call-flow" in c: return "oracle"
        verbs = [seg.split()[0] for seg in re.split(r"&&|\|\||;|\|", c) if seg.split()]
        if any(v in SEARCH_VERBS for v in verbs): return "search"
        if any(v in READ_VERBS for v in verbs): return "read"
        if any(v in ("ls", "find") for v in verbs): return "list"
        return "other"
    if name == "Read": return "read"
    if name in ("Grep", "Glob"): return "search"
    return "other"

def run(f):
    seq, denied, done_at, res = [], set(), None, None
    for line in open(f, errors="replace"):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get("message")
        if isinstance(m, dict) and m.get("role") == "assistant" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    seq.append((b["id"], kind(b.get("name", ""), b.get("input") or {})))
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    c = b.get("content"); t = c if isinstance(c, str) else json.dumps(c)
                    if done_at is None and "DONE" in t: done_at = len(seq)
        if d.get("type") == "result":
            res = d
            denied = {p.get("tool_use_id") for p in d.get("permission_denials") or []}
    if res is None: return None
    u = res.get("usage") or {}
    before = seq[:done_at] if done_at is not None else seq
    after = seq[done_at:] if done_at is not None else []
    cnt = lambda part, k: sum(1 for i, t in part if t == k and i not in denied)
    ref = lambda part: sum(1 for i, _ in part if i in denied)
    cr, cw = u.get("cache_read_input_tokens", 0), u.get("cache_creation_input_tokens", 0)
    turns = res.get("num_turns", 0); den = len(denied)
    return dict(
        calls=len(seq), turns=turns, done=done_at, den=den,
        after=len(after), after_exec=len(after) - ref(after), after_ref=ref(after),
        after_search=cnt(after, "search"), after_read=cnt(after, "read"),
        before_search=cnt(before, "search"), before_read=cnt(before, "read"),
        cr=cr, cw=cw, ctx=cr + cw,
        ctx_adj=(cr + cw) - den * ((cr + cw) / turns if turns else 0),
        cost=res.get("total_cost_usd", 0.0),
        cost_adj=res.get("total_cost_usd", 0.0) - den * ((cr + cw) / turns if turns else 0) * P["cr"])

runs = collections.defaultdict(dict)
for f in sorted(glob.glob(os.path.join(HERE, "*.[ACD].jsonl"))):
    rd, arm, _ = os.path.basename(f).split(".")
    r = run(f)
    if r: runs[arm][rd] = r
rounds = sorted(set(runs["A"]) & set(runs["C"]) & set(runs["D"]))
if not rounds:
    print("no complete paired rounds yet"); sys.exit(2)
M = lambda a, k: st.mean(runs[a][r][k] for r in rounds)
V = lambda a, k: [runs[a][r][k] for r in rounds]

print(f"paired rounds: {rounds}   (n={len(rounds)})\n")
print(f"{'':22}{'GREP':>12}{'REPLAY':>12}{'REPLAY+grep':>14}")
for k, lbl, fmt in [("calls", "tool calls", "{:.1f}"), ("turns", "model turns", "{:.1f}"),
                    ("den", "refused", "{:.1f}"), ("ctx", "total input ctx", "{:,.0f}"),
                    ("cw", "cache write", "{:,.0f}"), ("cost", "billed cost $", "{:.3f}")]:
    print(f"{lbl:22}" + "".join(f"{fmt.format(M(a,k)):>{12 if a!='D' else 14}}" for a in "ACD"))

print("\n## after the oracle said DONE")
for a in "CD":
    print(f"  {NAME[a]:12} DONE at {V(a,'done')}   calls after {V(a,'after')}  mean {M(a,'after'):.1f}")
    print(f"  {'':12} of which executed {M(a,'after_exec'):.1f} (search {M(a,'after_search'):.1f}, read {M(a,'after_read'):.1f}), refused {M(a,'after_ref'):.1f}")
print(f"\n  D searched BEFORE finishing the oracle: {V('D','before_search')}  (non-zero means it did not simply walk the oracle first)")

print("\n## paired, per round")
for a in "CD":
    after_gap = [runs['C'][r]['after'] - runs['D'][r]['after'] for r in rounds] if a == 'D' else None
for lbl, fn in [("cost ratio vs GREP, raw",      lambda a, r: runs[a][r]['cost'] / runs['A'][r]['cost']),
                ("cost ratio vs GREP, adjusted", lambda a, r: runs[a][r]['cost_adj'] / runs['A'][r]['cost']),
                ("total ctx vs GREP, adjusted",  lambda a, r: runs[a][r]['ctx_adj'] / runs['A'][r]['ctx'])]:
    for a in "CD":
        v = [fn(a, r) for r in rounds]
        print(f"  {lbl:30} {NAME[a]:12} " + " ".join(f"{x:.2f}" for x in v) + f"   mean {st.mean(v):.3f}")
d = [runs['C'][r]['after'] - runs['D'][r]['after'] for r in rounds]
print(f"\n  calls after DONE, C minus D, per round: {d}   mean {st.mean(d):.1f}")
if len(d) > 1 and st.stdev(d) > 0:
    print(f"  paired t = {st.mean(d)/(st.stdev(d)/len(d)**.5):.2f}  (df={len(d)-1})")
print("  (that count includes arm C's refused calls, which stop once search is allowed)")
e = [runs["C"][r]["after_exec"] - runs["D"][r]["after_exec"] for r in rounds]
print(f"  checks that RAN after DONE, C minus D, per round: {e}   mean {st.mean(e):.1f}")
if len(e) > 1 and st.stdev(e) > 0:
    print(f"  paired t = {st.mean(e)/(st.stdev(e)/len(e)**.5):.2f}  (df={len(e)-1})")

print("\n## orientation only — the published rounds, another rig:  REPLAY 20.8 calls, DONE #6, 14.8 after, 4.6 refused; GREP 22.4")
