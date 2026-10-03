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
notes.append("§1: wall clock comes from the shell-timed .secs files; duration_ms is ~2s lower. Say which.")

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
if len(MODELS) > 1:
    notes.append(f"§3.1: {len(MODELS)} models are billed in every run, not one. "
                 f"The fit is exact against the {MODEL} entry; total_cost_usd carries the auxiliary "
                 f"model too.")

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

print("\n## §4.3 decomposition of arm C's adjusted gap")
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

print("\n## §4.2 / §4.3 derivations (algebra over the FITTED price vector, so they move with it)")
check("break-even bar (read/write price)", PRICE["cr"] / PRICE["cw"], 0.050, 0.0005, "{:.3f}")
cw_m, cr_m = PRICE["cw"] * 1e6, PRICE["cr"] * 1e6
for T, p in [(20, 1.00), (10, 1.50), (4, 3.00), (2, 5.50), (1, 10.50)]:
    check(f"amortised $/Mtok-turn at T={T}", (cw_m + cr_m * T) / T, p, 0.005, "${:.2f}")

print("\n## §4.4 thinking tokens — source matters")
for a in ARMS:
    paper = {"A": 1108, "B": 2177, "C": 2145}[a]
    check(f"thinking tokens [{NAME[a]}]", M(a, "think"), paper, 5, "{:.0f}")
    print(f"        (usage.output_tokens_details.thinking_tokens; paper uses streamed estimated_tokens)")
for a in "BC":
    paper = {"B": 1.97, "C": 1.94}[a]
    check(f"thinking ratio vs GREP [{NAME[a]}]", M(a, "think") / M("A", "think"), paper, 0.02, "{:.2f}")

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
print("        GREP and SEAM have no completion marker, so 'calls after the answer was complete'")
print("        does not exist for them; the paper no longer reports it, and neither does this script.")

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
