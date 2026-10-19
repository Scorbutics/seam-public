#!/usr/bin/env python3
"""Does the verification floor survive a change of model? Two batches, one question.

    python3 bench/replay-ceiling/results-sonnet-clean/compare.py

    OPUS       ../results/              the paper's data (CLI 2.1.239)
    CLEAN      this directory           Sonnet again, with --add-dir, keycloak pinned (see WHY.md)

For every round it separates what the agent DID from what the harness REFUSED, and splits refusals
into the ones the design intends (search, denied to the oracle arm) and the ones it does not (any verb
the arm was granted). A granted verb refused is an apparatus failure, not behaviour: a batch with any
is not evidence about the model.
"""
import json, glob, os, re, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
BATCHES = [("OPUS (published)", os.path.join(HERE, "..", "results")),
           ("SONNET, clean", HERE)]
SEARCH = {"rg", "grep", "egrep", "fgrep", "ag", "ack", "fd"}

def verbs(cmd):
    """Every command a shell line runs, `cd` aside: `cd x && sed … | grep …` runs sed and grep."""
    out = []
    for seg in re.split(r"&&|\|\||;|\|", cmd or ""):
        w = seg.split()
        if w and w[0] != "cd":
            out.append(os.path.basename(w[0]))
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
                    calls.append((b["id"], b.get("name", ""), b.get("input") or {}))
                elif m.get("role") == "user" and b.get("type") == "tool_result" and done_at is None:
                    c = b.get("content"); t = c if isinstance(c, str) else json.dumps(c)
                    if "DONE" in t: done_at = len(calls)
        if d.get("type") == "result": res = d
    if res is None: return None                      # still running, or died: not a round
    refused = {p.get("tool_use_id") for p in res.get("permission_denials") or []}
    by_design = granted = 0
    for i, name, inp in calls:
        if i not in refused: continue
        v = verbs(inp.get("command")) if name == "Bash" else [name]
        searched = any(x in SEARCH or x in ("Grep", "Glob") for x in v)
        # Search is denied to the oracle arm by design; the control is granted everything it runs.
        if arm == "C" and searched: by_design += 1
        else: granted += 1
    after = calls[done_at:] if done_at is not None else []
    return dict(calls=len(calls), done=done_at, after=len(after),
                after_ran=sum(1 for i, _, _ in after if i not in refused),
                refused_by_design=by_design, refused_granted=granted,
                cost=res.get("total_cost_usd", 0.0))

def batch(label, d):
    rows = {}
    for arm in "AC":
        rows[arm] = [r for r in (run(f, arm) for f in sorted(glob.glob(os.path.join(d, f"*.{arm}.jsonl")))) if r]
    C, A = rows["C"], rows["A"]
    if not C: return None
    print(f"{label}   ({len(C)} rounds)")
    for r in C:
        print(f"   C  {r['calls']:3d} calls  DONE #{r['done']}  {r['after']:3d} after  {r['after_ran']:3d} ran"
              f"   refused: {r['refused_by_design']} search (by design), {r['refused_granted']} GRANTED verbs")
    for r in A:
        print(f"   A  {r['calls']:3d} calls{'':30}refused: {r['refused_granted']} GRANTED verbs")
    bad = sum(r["refused_granted"] for r in C + A)
    ran = [r["after_ran"] for r in C]
    print(f"   checks that ran after DONE {ran}  mean {st.mean(ran):.1f}")
    if A:
        print(f"   control calls {[r['calls'] for r in A]}  cost C/A {st.mean(r['cost'] for r in C) / st.mean(r['cost'] for r in A):.2f}")
    print("   APPARATUS: " + ("clean — no granted verb refused" if bad == 0 else
                             f"FAILED — {bad} granted verb(s) refused; this batch is not evidence"))
    print()
    return ran

print("=" * 96)
print("DOES THE VERIFICATION FLOOR SURVIVE A CHANGE OF MODEL?")
print("=" * 96 + "\n")
res = {label: batch(label, d) for label, d in BATCHES}
opus, clean = res["OPUS (published)"], res["SONNET, clean"]
if opus and clean:
    inside = sum(1 for x in clean if min(opus) <= x <= max(opus))
    print(f"clean Sonnet rounds inside the Opus range of checks that ran ({min(opus)}-{max(opus)}): "
          f"{inside}/{len(clean)}")
