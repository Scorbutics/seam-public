#!/usr/bin/env python3
"""A SECOND, INDEPENDENT implementation of the study's figures.

Written from the raw transcripts alone. It does not import, call, or copy measure.py:
the whole point is that two implementations that never shared code must agree, or one
of them is wrong. Where they disagree, this script says so rather than deferring.

    python3 bench/replay-ceiling/verify_independent.py [results-dir]

The directory is optional and defaults to results/. Point it at a probe directory to read a
replication (another model, another machine) with the same instrument. The round-file glob is
<round>.<arm>.jsonl in either case, so a probe needs no renaming; what it does NOT get is the
paper's published figures to compare against, because those describe the Opus set and nothing
else. That comparison is gated on the model and the round count, not on the directory name.

The price vector is FITTED from the transcripts' own modelUsage by least squares, never
assumed, so the same script can audit a replication on another model. Where the model IS the
one the paper ran on, the fit is checked against the published prices and every figure is
compared to the published one; where it is not, the figures are printed as a table, because
there is nothing to compare them against.

Exit 0 = nothing contradicted. Exit 1 = a checked figure did not reproduce. There is no third
code. Figures it CANNOT check (answer F1/precision/recall, and every paper figure when these
are not the paper's transcripts) are listed as UNCHECKED, never as passing: a check that
looked at nothing has not passed.
"""
import json, glob, os, sys, statistics as st, collections

_HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(_HERE, "results")
NAME = {"A": "GREP", "B": "SEAM", "C": "REPLAY"}
ARMS = "ABC"
ORACLE_DONE_STEP = 6          # arm C's oracle prints DONE at step 6
COLS = ("in", "cr", "cw", "out")

# The model the published study ran on, spelled exactly as the provider bills it: the "[1m]"
# suffix is PART OF THE NAME. claude-opus-5[1m] and claude-opus-5 are different products with
# different cache TTLs and different prices, so they are never folded together here.
PAPER_MODEL = "claude-opus-5[1m]"
PAPER_SHAPE = (5, 3)          # the set the paper documents: 5 rounds x 3 arms

# Published prices, $/token. NOT an input to any figure below — the price vector is fitted from
# the transcripts. This is the check ON that fit, and it is the point of the exercise: a price
# vector silently fitted from the wrong data is worse than a hardcoded one.
KNOWN_PRICE = {PAPER_MODEL: {"in": 5e-6, "cr": 0.5e-6, "cw": 10e-6, "out": 25e-6}}

fails, notes, unchecked, tabled = [], [], [], []


def primary_model(mu, usage):
    """Which modelUsage entry is the model under study — read from the data, not matched by name.

    The result event's top-level `usage` block is the primary model's own usage, so the entry whose
    four counters equal it IS the primary; anything else (a small auxiliary the harness calls for
    its own housekeeping) is billed alongside and is not what the study measures. Falls back to the
    costliest entry only if nothing matches exactly.
    """
    want = (usage.get("input_tokens", 0), usage.get("cache_read_input_tokens", 0),
            usage.get("cache_creation_input_tokens", 0), usage.get("output_tokens", 0))
    for k, v in mu.items():
        if (v.get("inputTokens", 0), v.get("cacheReadInputTokens", 0),
                v.get("cacheCreationInputTokens", 0), v.get("outputTokens", 0)) == want:
            return k
    return max(mu, key=lambda k: mu[k].get("costUSD", 0.0)) if mu else None


def _solve(A, b):
    """Least squares by normal equations, columns scaled to unit norm first (they span 1e1..1e6).

    Pure standard library on purpose: numpy is used when present, and this is what runs when it is
    not. Raises when the system is singular rather than returning a confident wrong vector.
    """
    n = len(A[0])
    scale = [sum(r[j] * r[j] for r in A) ** 0.5 or 1.0 for j in range(n)]
    As = [[r[j] / scale[j] for j in range(n)] for r in A]
    m = [[sum(row[i] * row[j] for row in As) for j in range(n)] + [sum(As[k][i] * b[k] for k in range(len(b)))]
         for i in range(n)]
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(m[r][i]))
        m[i], m[piv] = m[piv], m[i]
        if abs(m[i][i]) < 1e-12:
            raise ValueError("singular normal matrix: the token columns are collinear across runs")
        for r in range(n):
            if r != i:
                f = m[r][i] / m[i][i]
                for c in range(i, n + 1):
                    m[r][c] -= f * m[i][c]
    return [m[i][n] / m[i][i] / scale[i] for i in range(n)]


def fit_prices(rows):
    """Fit $/token for (input, cache_read, cache_write, output) from >=4 runs of one model.

    Each run gives one equation `in*p_in + cr*p_cr + cw*p_cw + out*p_out = costUSD`; with more runs
    than unknowns the system is overdetermined, so it is solved by least squares. numpy if it is
    installed, the normal equations above if it is not — no dependency is added to the repo.
    """
    A = [list(r[:4]) for r in rows]
    b = [r[4] for r in rows]
    try:
        import numpy
    except ImportError:
        x, how = _solve(A, b), "normal equations, pure python (numpy not installed)"
    else:
        x, how = [float(v) for v in numpy.linalg.lstsq(numpy.array(A, float),
                                                       numpy.array(b, float), rcond=None)[0]], "numpy.linalg.lstsq"
    resid = max(abs(sum(A[k][j] * x[j] for j in range(len(x))) - b[k]) for k in range(len(b)))
    return dict(zip(COLS, x)), resid, how


def load():
    runs = collections.defaultdict(dict)
    for f in sorted(glob.glob(os.path.join(RES, "*.[ABC].jsonl"))):
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
                pm = primary_model(mu, u)
                bill = mu.get(pm) or {}
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
                    primary=pm,
                    primary_cost=bill.get("costUSD", 0.0),
                    bill=(bill.get("inputTokens", 0), bill.get("cacheReadInputTokens", 0),
                          bill.get("cacheCreationInputTokens", 0), bill.get("outputTokens", 0),
                          bill.get("costUSD", 0.0)),
                    models=sorted(mu.keys()),
                    den=len(d.get("permission_denials") or []),
                    wall_ms=d.get("duration_ms", 0) / 1000.0,
                    api=d.get("duration_api_ms", 0) / 1000.0,
                    wall_secs=float(open(secs).read().strip()) if os.path.exists(secs) else None,
                )
    return runs


def check(label, mine, paper, tol, fmt="{:.1f}"):
    if not PAPER_SET:        # no published figure for this model: print it, claim nothing
        print(f"  --    {label:44} mine={fmt.format(mine):>12}  (no published figure)")
        tabled.append(label)
        return None
    ok = abs(mine - paper) <= tol
    print(f"  {'ok ' if ok else 'FAIL'}  {label:44} mine={fmt.format(mine):>12}  paper={fmt.format(paper):>12}")
    if not ok:
        fails.append(label)
    return ok


runs = load()
NRUN = sum(len(runs[a]) for a in ARMS)
if not NRUN:
    print(f"no r?.?.jsonl transcripts under {RES} — scanned 0 runs, so nothing is proved")
    sys.exit(1)
print("=" * 96)
print("INDEPENDENT RE-DERIVATION — docs/STUDY_STRUCTURAL_LIMITS.md, from results/r?.?.jsonl")
print("=" * 96)

print("\n## §0 which model produced these transcripts — read from modelUsage, not assumed")
MODELS = sorted({m for a in ARMS for r in runs[a] for m in runs[a][r]["models"]})
seen = collections.Counter(runs[a][r]["primary"] for a in ARMS for r in runs[a])
for m, n in sorted(seen.items()):
    print(f"        primary    {m:34} {n:2}/{NRUN} runs")
for m in MODELS:
    if m not in seen:
        print(f"        auxiliary  {m:34}    billed alongside; not the model under study")
if len(seen) != 1:
    print(f"\n  FAIL  the round set mixes {len(seen)} primary models: " + ", ".join(sorted(seen)))
    print("        Every figure below is a mean across the rounds, and these rounds were not priced")
    print("        or served alike — averaging them would present a comparison as a measurement.")
    print("        Split the transcripts by model and run this script once per set.")
    sys.exit(1)
MODEL = next(iter(seen))

print("\n## §0 price vector — fitted from the transcripts by least squares, not hardcoded")
rows = [runs[a][r]["bill"] for a in ARMS for r in sorted(runs[a])]
if len(rows) < len(COLS):
    print(f"  FAIL  {len(rows)} run(s) for {len(COLS)} unknown prices — the system is underdetermined.")
    print("        No dollar figure below can be derived; refusing to print one.")
    sys.exit(1)
try:
    PRICE, resid, how = fit_prices(rows)
except ValueError as e:
    print(f"  FAIL  the price system could not be solved: {e}")
    sys.exit(1)
print(f"        {how} — {len(rows)} equations, {len(COLS)} unknowns")
print("        " + "  ".join(f"{k}=${PRICE[k] * 1e6:9.4f}/Mtok" for k in COLS))
print(f"        max residual against the billed costUSD  ${resid:.9f}")
known = KNOWN_PRICE.get(MODEL)
if known:
    off = [k for k in COLS if abs(PRICE[k] - known[k]) > 1e-3 * abs(known[k])]
    for k in COLS:
        print(f"  {'ok ' if k not in off else 'FAIL'}  {'fitted vs published price: ' + k:44}"
              f"mine=${PRICE[k] * 1e6:>10.4f}  paper=${known[k] * 1e6:>9.4f}")
    if off:
        print(f"\n  FAIL  the fitted price vector contradicts the published {MODEL} prices.")
        print("        Either these transcripts are not what they claim to be, or the fit is wrong.")
        print("        Both make every dollar figure below meaningless, so none is computed.")
        sys.exit(1)
else:
    print(f"  --    no published price vector for {MODEL}: the residual above is the only evidence")
    unchecked.append(f"the fitted price vector for {MODEL} — this script knows no published prices "
                     f"for it, so only its own residual attests to it")

shape = (len({r for a in ARMS for r in runs[a]}), sum(1 for a in ARMS if runs[a]))
PAPER_SET = (MODEL == PAPER_MODEL and shape == PAPER_SHAPE)
if PAPER_SET:
    print(f"\n        -> {MODEL}, {shape[0]}x{shape[1]} runs: these ARE the transcripts")
    print("           docs/STUDY_STRUCTURAL_LIMITS.md reports, so its figures are checked below.")
else:
    print(f"\n        -> {MODEL}, {shape[0]}x{shape[1]} runs — NOT the published set "
          f"({PAPER_MODEL}, {PAPER_SHAPE[0]}x{PAPER_SHAPE[1]}).")
    print("           The paper's figures describe a different set, so comparing against them would")
    print("           measure nothing. Everything below is printed as a TABLE with no pass/fail:")
    print("           there is no published figure to compare it against.")

empty = [NAME[a] for a in ARMS if not runs[a]]
if empty:
    print(f"\n  FAIL  no runs for arm(s): {', '.join(empty)}. Every figure below is a comparison")
    print("        between the three arms, so none of them can be computed from this set.")
    sys.exit(1)
M = lambda a, k: st.mean(runs[a][r][k] for r in sorted(runs[a]))
ctx = {a: (M(a, "cr") + M(a, "cw")) / M(a, "turns") for a in ARMS}   # (read+write)/turns

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

print("\n## §1 wall clock — source is the .secs files, not duration_ms")
for a in ARMS:
    paper = {"A": 85, "B": 119, "C": 89}[a]
    check(f"wall from .secs [{NAME[a]}]", st.mean(runs[a][r]["wall_secs"] for r in sorted(runs[a])), paper, 0.5, "{:.0f}")
    print(f"        (duration_ms would give {M(a,'wall_ms'):.0f}s)")

print("\n## §1 billed cost")
base = M("A", "cost")
for a in ARMS:
    check(f"cost ratio vs GREP [{NAME[a]}]", M(a, "cost") / base,
          {"A": 1.00, "B": 1.42, "C": 1.26}[a], 0.005, "{:.2f}")
for a in "BC":
    got = [runs[a][r]["cost"] / runs["A"][r]["cost"] for r in sorted(runs[a])]
    label = f"paired per-round ratios [{NAME[a]}]"
    if not PAPER_SET:
        print(f"  --    {label:44} " + " ".join(f"{v:.2f}" for v in got))
        tabled.append(label)
        continue
    paper = {"B": [1.01, 1.37, 1.51, 1.68, 1.53], "C": [1.26, 1.18, 1.00, 1.41, 1.48]}[a]
    # zip() truncates, so a short round set would "pass" on a prefix: compare the lengths too.
    ok = len(got) == len(paper) and all(abs(g - p) <= 0.015 for g, p in zip(got, paper))
    print(f"  {'ok ' if ok else 'FAIL'}  {label}   " + " ".join(f"{v:.2f}" for v in got))
    if not ok:
        fails.append(f"paired ratios {NAME[a]}")

print("\n## §3.1 'model PINNED' / §3.3 'zero residual'")
print(f"        models billed across the {NRUN} runs: {MODELS}")
worst_tot = worst_primary = 0.0
for a in ARMS:
    for rd in runs[a]:
        r = runs[a][rd]
        pred = r["inp"] * PRICE["in"] + r["cr"] * PRICE["cr"] + r["cw"] * PRICE["cw"] + r["out"] * PRICE["out"]
        worst_tot = max(worst_tot, abs(pred - r["cost"]))
        worst_primary = max(worst_primary, abs(pred - r["primary_cost"]))
exact = worst_primary <= 1e-6                 # a verdict, not a label: the residual decides it
print(f"  {'ok ' if exact else 'FAIL'}   fit vs the {MODEL} modelUsage entry   "
      f"max residual ${worst_primary:.7f}  ({NRUN} runs)")
print(f"  NOTE  fit vs total_cost_usd                 max residual ${worst_tot:.5f}  (the auxiliary model)")
if not exact:
    fails.append("four-price model fits the primary modelUsage entry")
print("\n## §4.1 the identity, and the product that cancels")
for a in ARMS:
    gap = M(a, "turns") * ctx[a] - M(a, "cr")
    print(f"        {NAME[a]:7} turns x ctx = {M(a,'turns')*ctx[a]:>12,.0f}   cache_read = {M(a,'cr'):>12,.0f}"
          f"   gap = {gap:>9,.0f}   cache_write = {M(a,'cw'):>9,.0f}")

Ctot = {a: M(a, "cr") + M(a, "cw") for a in ARMS}
print("\n        product turns_ratio x context_ratio == total-context ratio (turns cancel algebraically):")
for a in "BC":
    tr = M(a, "turns") / M("A", "turns")
    cr_ = ctx[a] / ctx["A"]
    print(f"        {NAME[a]:7} {tr:.3f} x {cr_:.3f} = {tr*cr_:.4f}   and  C_x/C_A = {Ctot[a]/Ctot['A']:.4f}")

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

print("\n## §4.2 decomposition of arm C's adjusted gap")
dec = {
    "cache write": ((M("C", "cw") - M("A", "cw")) * PRICE["cw"], 0.1321),
    "cache read":  ((M("C", "cr") - d * ctx["C"] - M("A", "cr")) * PRICE["cr"], -0.0051),
    "output":      ((M("C", "out") - M("A", "out")) * PRICE["out"], 0.0047),
}
tot_mine = sum(v[0] for v in dec.values())
for k, (mine, paper) in dec.items():
    check(f"{k}", mine, paper, 0.002, "{:+.4f}")
check("TOTAL gap ($)", tot_mine, 0.1317, 0.002, "{:+.4f}")
check("TOTAL gap (%)", tot_mine / base * 100, 13.2, 0.5, "{:.1f}")

print("\n## §4.2 derivations (algebra over the FITTED price vector, so they move with it)")
check("break-even bar (read/write price)", PRICE["cr"] / PRICE["cw"], 0.050, 0.0005, "{:.3f}")
cw_m, cr_m = PRICE["cw"] * 1e6, PRICE["cr"] * 1e6
for T, p in [(20, 1.00), (10, 1.50), (4, 3.00), (2, 5.50), (1, 10.50)]:
    check(f"amortised $/Mtok-turn at T={T}", (cw_m + cr_m * T) / T, p, 0.005, "${:.2f}")

print("\n## §4.3 thinking tokens — source matters")
for a in ARMS:
    paper = {"A": 1108, "B": 2177, "C": 2145}[a]
    check(f"thinking tokens [{NAME[a]}]", M(a, "think"), paper, 5, "{:.0f}")
print("        (usage.output_tokens_details.thinking_tokens, the provider's count; the paper uses the same)")
for a in "BC":
    paper = {"B": 1.97, "C": 1.94}[a]
    check(f"thinking ratio vs GREP [{NAME[a]}]", M(a, "think") / M("A", "think"), paper, 0.02, "{:.2f}")
d_think = M("C", "think") - M("A", "think")
d_other = (M("C", "out") - M("C", "think")) - (M("A", "out") - M("A", "think"))
check("extra thinking [REPLAY - GREP]", d_think, 1040, 10, "{:+.0f}")
check("other output [REPLAY - GREP]", d_other, -850, 10, "{:+.0f}")
check("net output [REPLAY - GREP]", d_think + d_other, 190, 10, "{:+.0f}")
check("output share of cost [REPLAY] (%)", M("C", "out") * PRICE["out"] / M("C", "cost") * 100, 13, 0.5, "{:.1f}")
check("extra thinking priced alone / output term", d_think / (d_think + d_other), 5.5, 0.5, "{:.1f}")

def thinking_split(path):
    """Provider thinking per message (message_delta usage), split at the DONE result, plus the run total."""
    pre = post = 0; done = False; total = None
    for line in open(path, errors="replace"):
        try: d = json.loads(line)
        except Exception: continue
        if d.get("type") == "result":
            total = ((d.get("usage") or {}).get("output_tokens_details") or {}).get("thinking_tokens", 0)
        ev = d.get("event") if d.get("type") == "stream_event" else None
        if isinstance(ev, dict) and ev.get("type") == "message_delta":
            th = ((ev.get("usage") or {}).get("output_tokens_details") or {}).get("thinking_tokens", 0)
            if done: post += th
            else: pre += th
        m = d.get("message")
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    c = b.get("content"); t = c if isinstance(c, str) else json.dumps(c)
                    if "DONE" in t: done = True
    return pre, post, total
tsplit = {a: [thinking_split(os.path.join(RES, f"{rd}.{a}.jsonl")) for rd in sorted(runs[a])] for a in ARMS}
check("per-message thinking sums to the run total, every run",
      float(all(p + q == t for a in ARMS for p, q, t in tsplit[a])), 1.0, 0, "{:.0f}")
tc = tsplit["C"]
check("thinking before DONE [REPLAY]", sum(p for p, _, _ in tc) / len(tc), 19, 0.5, "{:.1f}")
check("thinking after DONE [REPLAY]", sum(q for _, q, _ in tc) / len(tc), 2126, 0.5, "{:.1f}")
check("share of thinking after DONE [REPLAY] (%)", sum(q for _, q, _ in tc) / sum(t for _, _, t in tc) * 100, 99, 0.5, "{:.1f}")

print("\n## §5 the verification floor — arm C only, split at its own DONE")
def done_index(path):
    """Position of the call whose result first carried the oracle's DONE, counted from the transcript."""
    calls = 0
    for line in open(path, errors="replace"):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get("message")
        if not isinstance(m, dict) or not isinstance(m.get("content"), list): continue
        if m.get("role") == "assistant":
            calls += sum(1 for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_use")
        elif m.get("role") == "user":
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    c = b.get("content"); t = c if isinstance(c, str) else json.dumps(c)
                    if "DONE" in t: return calls
    return None
dones = [done_index(os.path.join(RES, f"{rd}.C.jsonl")) for rd in sorted(runs["C"])]
print(f"        DONE at call {dones} — measured from the transcripts, not assumed")
check("DONE lands at the same call in every round", float(len(set(dones)) == 1 and dones[0] == ORACLE_DONE_STEP), 1.0, 0, "{:.0f}")
check("calls after DONE [REPLAY]", M("C", "calls") - ORACLE_DONE_STEP, 14.8, 0.05, "{:.1f}")
check("refused after DONE [REPLAY]", M("C", "den"), 4.6, 0.05, "{:.1f}")

def context_split(path):
    """(read+write) of every model turn before the DONE result, and of the whole run, from per-message usage.

    Streaming repeats one message id across several lines; the last usage seen for an id is its own."""
    per, before, done = {}, set(), False
    for line in open(path, errors="replace"):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get("message")
        if not isinstance(m, dict): continue
        if m.get("role") == "assistant" and m.get("id"):
            u = m.get("usage") or {}
            per[m["id"]] = u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            if not done: before.add(m["id"])
        elif m.get("role") == "user" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    c = b.get("content"); t = c if isinstance(c, str) else json.dumps(c)
                    if "DONE" in t: done = True
    return sum(per[i] for i in before), sum(per.values())
splits = [context_split(os.path.join(RES, f"{rd}.C.jsonl")) for rd in sorted(runs["C"])]
pre = sum(p for p, _ in splits) / len(splits)
whole = sum(w for _, w in splits) / len(splits)
check("per-message context sums to the result's [REPLAY]", whole, Ctot["C"], 1, "{:,.0f}")
check("context before DONE [REPLAY] (k)", pre / 1e3, 346, 0.5, "{:.0f}")
adj_c = Ctot["C"] - M("C", "den") * ctx["C"]
check("executed context after DONE [REPLAY] (k)", (adj_c - pre) / 1e3, 637, 0.5, "{:.0f}")
check("refused context [REPLAY] (k)", (Ctot["C"] - adj_c) / 1e3, 263, 0.5, "{:.0f}")
check("context before DONE / control", pre / Ctot["A"], 0.35, 0.005, "{:.3f}")
check("executed checking after DONE / control", (adj_c - pre) / Ctot["A"], 0.65, 0.005, "{:.3f}")

def writes_per_turn(path):
    """cache_creation of each model turn, in order; the last usage seen for a message id is its own."""
    per, order = {}, []
    for line in open(path, errors="replace"):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get("message")
        if isinstance(m, dict) and m.get("role") == "assistant" and m.get("id"):
            if m["id"] not in per: order.append(m["id"])
            per[m["id"]] = (m.get("usage") or {}).get("cache_creation_input_tokens", 0)
    return [per[i] for i in order]
wpt = [writes_per_turn(os.path.join(RES, f"{rd}.C.jsonl")) for rd in sorted(runs["C"])]
print("        writes, turns 1-7 (k): " + " | ".join(" ".join(f"{x/1e3:.1f}" for x in w[:7]) for w in wpt))
check("same writes on turns 1-7 in every round [REPLAY]",
      float(max(max(w[t] for w in wpt) - min(w[t] for w in wpt) for t in range(7)) <= 200), 1.0, 0, "{:.0f}")
check("turn-1 write: prompt (k) [REPLAY]", sum(w[0] for w in wpt) / len(wpt) / 1e3, 14.1, 0.05, "{:.1f}")
check("turn-3 write: step 2, the map (k) [REPLAY]", sum(w[2] for w in wpt) / len(wpt) / 1e3, 11.7, 0.05, "{:.1f}")
check("steps 1, 3-5 writes, smallest (k)", min(w[t] for w in wpt for t in (1, 3, 4, 5)) / 1e3, 0.9, 0.05, "{:.1f}")
check("steps 1, 3-5 writes, largest (k)", max(w[t] for w in wpt for t in (1, 3, 4, 5)) / 1e3, 2.6, 0.05, "{:.1f}")
print("        GREP and SEAM have no completion marker, so 'calls after the answer was complete'")
print("        does not exist for them; the paper no longer reports it, and neither does this script.")

print("\n## [kcC] the earlier six-round measurement (§1, §4.2) — bench/grep-vs-seam/results/kcC-ab*")
KCC = os.path.join(_HERE, "..", "grep-vs-seam", "results")
def kcc_run(path):
    calls, res = 0, None
    for line in open(path, errors="replace"):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get("message")
        if isinstance(m, dict) and m.get("role") == "assistant" and isinstance(m.get("content"), list):
            calls += sum(1 for b in m["content"] if isinstance(b, dict) and b.get("type") == "tool_use")
        if d.get("type") == "result": res = d
    u = res.get("usage") or {}
    return dict(calls=calls, turns=res.get("num_turns", 0),
                cw=u.get("cache_creation_input_tokens", 0), cr=u.get("cache_read_input_tokens", 0),
                out=u.get("output_tokens", 0), cost=res.get("total_cost_usd", 0.0),
                api=res.get("duration_api_ms", 0) / 1000.0,
                wall=float(open(path[:-len(".jsonl")] + ".secs").read().strip()))
kcc = {a: [kcc_run(f) for f in sorted(glob.glob(os.path.join(KCC, f"kcC-ab*.{a}.jsonl")))] for a in "AB"}
if PAPER_SET and all(kcc.values()):
    print(f"        rounds: GREP {len(kcc['A'])}, SEAM {len(kcc['B'])}")
    K = {a: {k: sum(r[k] for r in kcc[a]) / len(kcc[a]) for k in kcc[a][0]} for a in "AB"}
    ka, kb = K["A"], K["B"]
    check("[kcC] rounds per arm", min(len(kcc["A"]), len(kcc["B"])), 6, 0, "{:.0f}")
    check("[kcC] fewer tool calls (x)", ka["calls"] / kb["calls"], 2.7, 0.05, "{:.2f}")
    check("[kcC] bill, total incl. auxiliary model (x)", kb["cost"] / ka["cost"], 1.18, 0.005, "{:.3f}")
    check("[kcC] output tokens (x)", kb["out"] / ka["out"], 0.81, 0.005, "{:.3f}")
    check("[kcC] cache read (x)", kb["cr"] / ka["cr"], 0.81, 0.005, "{:.3f}")
    check("[kcC] API time (x)", kb["api"] / ka["api"], 0.81, 0.005, "{:.3f}")
    check("[kcC] cache write (x)", kb["cw"] / ka["cw"], 1.79, 0.005, "{:.3f}")
    check("[kcC] wall clock, shell-timed (x)", kb["wall"] / ka["wall"], 1.09, 0.005, "{:.3f}")
    check("[kcC] fewer turns (x)", ka["turns"] / kb["turns"], 2.6, 0.05, "{:.2f}")
    dw, dr = kb["cw"] - ka["cw"], ka["cr"] - kb["cr"]
    bar = PRICE["cr"] / PRICE["cw"]
    check("[kcC] added write / saved read", dw / dr, 0.176, 0.0005, "{:.3f}")
    check("[kcC] over the bar (x)", dw / dr / bar, 3.5, 0.05, "{:.2f}")
    check("[kcC] largest payload that breaks even (tok)", bar * dr, 6838, 1, "{:,.0f}")
    check("[kcC] turns that would break even", (ka["cr"] - dw / bar) / (kb["cr"] / kb["turns"]), 3.9, 0.05, "{:.2f}")
    check("[kcC] SEAM tool calls", kb["calls"], 8.7, 0.05, "{:.1f}")
elif not all(kcc.values()):
    unchecked.append(f"[kcC] figures — no kcC-ab*.[AB].jsonl under {os.path.normpath(KCC)}")

print("\n## §5.2 arm D — results-oracle-grep/, a separate rig: REPLAY with and without search, beside GREP")
ORG = os.path.join(_HERE, "results-oracle-grep")
SEARCH, READ = {"rg", "grep", "egrep"}, {"sed", "cat", "head", "tail", "awk", "wc"}
def call_kind(name, inp):
    """What a tool call does: oracle, search, read or other. A shell line that runs any search verb is a
    search (`sed … && grep …` searches); failing that, any read verb makes it a read."""
    if name in ("Grep", "Glob"): return "search"
    if name == "Read": return "read"
    if name != "Bash": return "other"
    cmd = (inp.get("command") or "")
    if "call-flow" in cmd: return "oracle"
    verbs = set()
    for part in cmd.replace("&&", "\n").replace("||", "\n").replace(";", "\n").replace("|", "\n").split("\n"):
        if part.split(): verbs.add(part.split()[0])
    return "search" if verbs & SEARCH else "read" if verbs & READ else "other"
def org_run(path):
    calls, done_at, res = [], None, None
    for line in open(path, errors="replace"):
        try: d = json.loads(line)
        except Exception: continue
        m = d.get("message")
        if isinstance(m, dict) and isinstance(m.get("content"), list):
            for b in m["content"]:
                if not isinstance(b, dict): continue
                if m.get("role") == "assistant" and b.get("type") == "tool_use":
                    calls.append((b["id"], call_kind(b.get("name", ""), b.get("input") or {})))
                elif m.get("role") == "user" and b.get("type") == "tool_result" and done_at is None:
                    c = b.get("content"); t = c if isinstance(c, str) else json.dumps(c)
                    if "DONE" in t: done_at = len(calls)
        if d.get("type") == "result": res = d
    refused = {x.get("tool_use_id") for x in res.get("permission_denials") or []}
    after = calls[done_at:] if done_at is not None else []
    ran = [k for i, k in after if i not in refused]
    u = res.get("usage") or {}
    ctx = u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
    turns = res.get("num_turns", 0)
    return dict(calls=len(calls), done=done_at, refused=len(refused), after=len(after),
                after_refused=sum(1 for i, _ in after if i in refused), after_ran=len(ran),
                search=ran.count("search"), read=ran.count("read"), other=ran.count("other"),
                search_before=sum(1 for _, k in calls[:done_at or 0] if k == "search"),
                cost=res.get("total_cost_usd", 0.0),
                cost_adj=res.get("total_cost_usd", 0.0) - len(refused) * (ctx / turns) * PRICE["cr"] if turns else 0.0)
org = {a: [org_run(f) for f in sorted(glob.glob(os.path.join(ORG, f"h?.{a}.jsonl")))] for a in "ACD"}
if PAPER_SET and all(org.values()):
    n_org = min(len(v) for v in org.values())
    Q = lambda a, k: sum(r[k] for r in org[a]) / len(org[a])
    check("arm D: paired rounds", n_org, 5, 0, "{:.0f}")
    for a, paper in (("A", 35.2), ("C", 32.2), ("D", 21.8)):
        check(f"arm D rig: tool calls [{ {'A': 'GREP', 'C': 'REPLAY', 'D': 'REPLAY+grep'}[a]}]", Q(a, "calls"), paper, 0.05)
    check("arm D rig: DONE at call 6 in every C and D round",
          float(all(r["done"] == ORACLE_DONE_STEP for a in "CD" for r in org[a])), 1.0, 0, "{:.0f}")
    check("arm D rig: D searches before DONE (all rounds)", sum(r["search_before"] for r in org["D"]), 0, 0, "{:.0f}")
    for a, row in (("C", (26.2, 7.8, 18.4, 0.0, 17.0, 1.4)), ("D", (15.8, 0.0, 15.8, 6.2, 9.6, 0.0))):
        nm = {"C": "REPLAY", "D": "REPLAY+grep"}[a]
        for k, paper in zip(("after", "after_refused", "after_ran", "search", "read", "other"), row):
            check(f"after DONE, {k} [{nm}]", Q(a, k), paper, 0.05)
    ran_diff = [c["after_ran"] - d["after_ran"] for c, d in zip(org["C"], org["D"])]
    mu = sum(ran_diff) / len(ran_diff)
    sd = (sum((x - mu) ** 2 for x in ran_diff) / (len(ran_diff) - 1)) ** 0.5
    print(f"        checks that ran after DONE, C minus D, per round: {ran_diff}")
    check("checks that ran: C minus D", mu, 2.6, 0.05)
    check("checks that ran: rounds where D ran fewer", sum(1 for x in ran_diff if x > 0), 4, 0, "{:.0f}")
    check("checks that ran: paired t (df=4)", mu / (sd / len(ran_diff) ** 0.5), 1.86, 0.01, "{:.2f}")
    check("D: checks after DONE / all its calls (%)", Q("D", "after") / Q("D", "calls") * 100, 72, 0.5, "{:.1f}")
    ratio = lambda a, k: [r[k] / g["cost"] for r, g in zip(org[a], org["A"])]
    rc_raw, rc_adj, rd = ratio("C", "cost"), ratio("C", "cost_adj"), ratio("D", "cost")
    check("cost vs GREP, raw [REPLAY]", sum(rc_raw) / 5, 1.23, 0.005, "{:.3f}")
    check("cost vs GREP, adjusted [REPLAY]", sum(rc_adj) / 5, 1.06, 0.005, "{:.3f}")
    check("cost vs GREP [REPLAY+grep]", sum(rd) / 5, 0.91, 0.005, "{:.3f}")
    md = sum(rd) / 5
    check("cost vs GREP, sd [REPLAY+grep]", (sum((x - md) ** 2 for x in rd) / 4) ** 0.5, 0.28, 0.005, "{:.3f}")
    check("D rounds above / level with / below GREP",
          float((sum(x > 1.005 for x in rd), sum(abs(x - 1) <= 0.005 for x in rd), sum(x < 0.995 for x in rd)) == (1, 1, 3)),
          1.0, 0, "{:.0f}")
    check("D cheaper than C, raw (rounds)", sum(d < c for d, c in zip(rd, rc_raw)), 5, 0, "{:.0f}")
    check("D cheaper than C, adjusted (rounds)", sum(d < c for d, c in zip(rd, rc_adj)), 4, 0, "{:.0f}")
elif not all(org.values()):
    unchecked.append(f"§5.2 arm D figures — no h?.[ACD].jsonl under {ORG}")

print("\n## §3.2 non-API ('engine') time")
for a in ARMS:
    print(f"        {NAME[a]:7} wall {M(a,'wall_ms'):6.1f}s   api {M(a,'api'):6.1f}s   non-API {M(a,'wall_ms')-M(a,'api'):+6.1f}s")

print("\n## UNCHECKED — this script cannot verify these; they are not passing, they are unexamined")
unchecked.insert(0, "answer F1 / precision / recall (needs re-scoring answers against truth.txt)")
if tabled:
    unchecked.append(f"{len(tabled)} figure(s) printed above as a table — {MODEL} is not the set "
                     f"docs/STUDY_STRUCTURAL_LIMITS.md documents, which publishes no figure they "
                     f"could be compared against")
for u in unchecked:
    print(f"  --    {u}")

print("\n" + "=" * 96)
if fails:
    print(f"{len(fails)} figure(s) did NOT reproduce:")
    for f in fails:
        print("   -", f)
elif PAPER_SET:
    print("Every checked figure reproduces from the transcripts.")
else:
    print(f"Nothing was contradicted — and nothing was compared: the {len(tabled)} figure(s) above")
    print(f"are derived for {MODEL}, which the study does not document. Exit 0 here means no")
    print("contradiction, not agreement.")
if PAPER_SET:
    print(f"\n{len(notes)} definitional / presentational finding(s):")
    for i, n in enumerate(notes, 1):
        print(f"  {i}. {n}")
else:
    print(f"\n{len(notes)} definitional finding(s) withheld: they are readings of the published Opus")
    print("figures, and these transcripts are not those.")
sys.exit(1 if fails else 0)
