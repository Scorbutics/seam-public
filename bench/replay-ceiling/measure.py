#!/usr/bin/env python3
"""Score the replay-ceiling arms on ANSWER QUALITY and on what they COST.

    python3 bench/replay-ceiling/measure.py [round-id ...]

WHY THIS EXISTS RATHER THAN REUSING bench/grep-vs-seam/score-answers.ts. That scorer measures recall,
precision and tool calls, which is what its question needed. This benchmark's question is COST, and cost is
not tool calls: the kcC batch measured 2.7x FEWER calls in the Seam arm and a 17% HIGHER bill. So the unit
here is the token, split by the four prices that are actually billed (input / cache-read / cache-write /
output), plus THINKING, which stream-json alone cannot see.

The scoring rules for the ANSWER block are taken verbatim from score-answers.ts and are not re-derived:
compare on FILE not file#symbol, and a claim is a line that LOOKS like a path. Both rules exist because that
scorer was twice caught measuring prose style instead of knowledge.
"""
import json, sys, glob, os, re, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "results")
ARMS = {"A": "GREP", "B": "SEAM", "C": "REPLAY"}
# Fitted EXACTLY (zero residual) against the 12 kcC runs' recorded modelUsage/costUSD, so the decomposition
# below is arithmetic on billed prices, not an estimate. $/token.
PRICE = {"inputTokens": 5e-6, "cacheReadInputTokens": 0.5e-6,
         "cacheCreationInputTokens": 10e-6, "outputTokens": 25e-6}

norm = lambda s: s.strip().replace("`", "").lstrip("./")
is_path = lambda s: re.fullmatch(r"[^\s]+\.[A-Za-z0-9]{1,6}(#\S+)?", s) and "`" not in s
file_of = lambda s: norm(s.split("#")[0])

def truth_files():
    """The truth set, file-level, with ONE wildcard row.

    `js/apps/admin-ui/src/**` stands for any of the ~20 UI callers of `adminClient.realms.update`. Naming one
    of them would score an arm on WHICH example it happened to pick — the prose-style defect grep-vs-seam had
    to fix twice. So it is matched as a PREFIX: any claim under that directory satisfies it, and satisfies it
    only once."""
    p = os.path.join(HERE, "truth.txt")
    ls = [norm(l) for l in open(p) if l.strip() and not l.lstrip().startswith("#")]
    exact, globs = set(), set()
    for l in ls:
        f = file_of(l)
        (globs if "**" in f else exact).add(f)
    return exact, globs

def answer_block(text):
    m = re.split(r"^##\s*ANSWER\s*$", text or "", flags=re.M)
    return m[-1] if len(m) > 1 else ""

def measure(path):
    """One run -> one row. Everything is read from the transcript; nothing is inferred."""
    r = dict(tool_calls=0, turns=0, think_chars=0, think_tok_raw=0, text_chars=0, cost=0.0,
             wall=0, api=0.0, dur=0.0, answer="", model=set(), denials=0)
    usage = {}
    for line in open(path):
        try: e = json.loads(line)
        except Exception: continue
        t = e.get("type")
        if t == "system" and e.get("subtype") == "init":
            r["model"].add(e.get("model"))
        elif t == "stream_event":
            # --include-partial-messages is the ONLY way thinking text reaches the transcript: the assembled
            # `thinking` blocks in the assistant events are stored with EMPTY content. The earlier benchmark
            # ran without it, which is why "thinking went up" was never directly evidenced there.
            d = e.get("event", {}).get("delta", {})
            # The thinking TEXT is redacted even in the deltas — but each one reports `estimated_tokens`,
            # which is the measurement this benchmark needs and the earlier one never had. Visible text has
            # no such field, so it is counted in characters and converted at the stated rate.
            if d.get("type") == "thinking_delta":
                r["think_tok_raw"] += d.get("estimated_tokens", 0) or 0
                r["think_chars"] += len(d.get("thinking", "") or "")
            elif d.get("type") == "text_delta":   r["text_chars"]  += len(d.get("text", "") or "")
        elif t == "assistant":
            for b in e["message"].get("content", []):
                if b.get("type") == "tool_use": r["tool_calls"] += 1
        elif t == "result":
            mu = e.get("modelUsage", {})
            for m, u in mu.items():
                if not m.startswith("claude-opus"): continue   # haiku is harness overhead, not agent work
                for k in PRICE: usage[k] = usage.get(k, 0) + (u.get(k) or 0)
            r["cost"] = e.get("total_cost_usd", 0.0)
            r["turns"] = e.get("num_turns", 0)
            r["api"] = e.get("duration_api_ms", 0) / 1000
            r["dur"] = e.get("duration_ms", 0) / 1000
            r["answer"] = e.get("result", "")
            r["denials"] = len(e.get("permission_denials", []))
    r.update(usage)
    secs = path.replace(".jsonl", ".secs")
    if os.path.exists(secs): r["wall"] = int(open(secs).read().strip())
    r["engine"] = round(r["dur"] - r["api"], 1)          # non-API time = tool execution
    for k in PRICE: r.setdefault(k, 0)
    r["think_tok"] = r["think_tok_raw"]                    # reported by the API, not estimated by us
    r["text_tok"]  = round(r["text_chars"] / 3.6)
    return r

# ── CONTAMINATION AUDIT ──────────────────────────────────────────────────────────────────────────────────
# The deny list is ADVISORY for the shell, so what an arm was ALLOWED is not what an arm DID. Every round is
# audited against what actually ran, and a contaminated round is reported rather than quietly averaged in —
# grep-vs-seam had its control silently turn into a second treatment arm twice this way.
SEARCH = re.compile(r"\b(rg|grep|egrep|fgrep|ag|ack|fd)\b")
# What each arm may legitimately run. The read/list verbs are legal for ALL arms — the only capability that
# differs is CONTENT SEARCH, which is arm A's alone (see run-arms.sh, and results/discarded-strict-read/WHY.md
# for the batch that was thrown away for getting this wrong).
READ_VERBS = r"cat|sed|head|tail|wc|ls|find|sort|uniq|cut|awk|comm|echo|true"
LEGAL = {"A": re.compile(r"^(rg|grep|fd|" + READ_VERBS + r")\b"),
         "B": re.compile(r"^(bun|" + READ_VERBS + r")\b"),
         "C": re.compile(r"(call-flow\b|^(" + READ_VERBS + r")\b)")}

def contamination(path, arm):
    """What an arm actually GOT, not what it reached for.

    An ATTEMPT the harness denied is not contamination — the control held. Counting attempts marks a clean
    round dirty and, worse, hides the real distinction: a denied call still costs the arm a turn, so it is
    apparatus overhead to report separately, not evidence the arm used a forbidden tool."""
    denied, bad, blocked = set(), [], []
    for line in open(path):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "result":
            denied = {d.get("tool_use_id") for d in e.get("permission_denials", [])}
    for line in open(path):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") != "assistant": continue
        for b in e["message"].get("content", []):
            if b.get("type") != "tool_use" or b["name"] != "Bash": continue
            cmd = (b["input"].get("command") or "").strip()
            # Strip a leading `cd <dir>` joined by EITHER `&&` or `;` — arm A wrote `cd repo; rg -n …`,
            # which the &&-only form mis-flagged as contamination on a verb that arm is allowed.
            first = re.sub(r"^cd\s+\S+\s*(?:&&|;)\s*", "", cmd)
            head = first.split("|")[0].strip()
            # A search verb ANYWHERE in the command line is contamination even when the command opens with a
            # legal verb — `ls x && grep y` was how the pilot's arm C slipped past a head-of-line check.
            if LEGAL[arm].search(head) and not (arm != "A" and SEARCH.search(first)): continue
            (blocked if b["id"] in denied else bad).append(cmd[:90])
    return bad, blocked


def score(r, tfs):
    exact, globs = tfs
    claims = {file_of(l) for l in map(norm, answer_block(r["answer"]).split("\n")) if l and is_path(l)}
    hit_exact = claims & exact
    hit_glob = {g for g in globs if any(c.startswith(g.split("**")[0]) for c in claims)}
    tp = len(hit_exact) + len(hit_glob)
    total = len(exact) + len(globs)
    p = tp / len(claims) if claims else 0.0
    c = tp / total if total else 0.0
    return dict(claimed=len(claims), tp=tp, prec=p, rec=c,
                f1=(2 * p * c / (p + c)) if p + c else 0.0,
                missed=sorted((exact - hit_exact) | (globs - hit_glob)))

def verification_split(path, arm, oracle_steps=6):
    """WHERE the money goes in the ideal arm: before the answer was complete, or after.

    Arm C's oracle announces DONE at step 6. Every call after that is the agent CHECKING an answer it has
    already been given in full — the behaviour every prior round of this project read as "grep-trained
    distrust" and could never separate from the tool's own shortcomings. With a perfect oracle there are no
    shortcomings left, so whatever remains is the floor.

    Returns (cost before, cost after, calls after). Only meaningful for arm C; reported for the others at the
    same call index so the split is like-for-like rather than a special case."""
    P2 = {"input_tokens": PRICE["inputTokens"], "cache_read_input_tokens": PRICE["cacheReadInputTokens"],
          "cache_creation_input_tokens": PRICE["cacheCreationInputTokens"],
          "output_tokens": PRICE["outputTokens"]}
    tools, pre, post, after, seen = 0, 0.0, 0.0, 0, set()
    for line in open(path):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") != "assistant": continue
        m = e["message"]; u = m.get("usage", {})
        c = sum((u.get(k, 0) or 0) * v for k, v in P2.items())
        if m.get("id") not in seen:
            seen.add(m.get("id"))
            if tools <= oracle_steps: pre += c
            else: post += c
        for b in m.get("content", []):
            if b.get("type") == "tool_use":
                tools += 1
                if tools > oracle_steps: after += 1
    return pre, post, after


def breakeven(means, base="A"):
    """WHY a retrieval tool struggles to lower the bill — stated as a break-even, not a verdict.

    An agent's bill is dominated by two token classes with a 20x price gap:

        cache WRITE  $10.00 /Mtok   paid ONCE per new block of content injected into the conversation
        cache READ   $ 0.50 /Mtok   paid EVERY subsequent turn, for the whole prompt

    (The 20x is this session's 1h cache TTL. On the 5m TTL a write is $6.25 and the ratio is 12.5x. The
    direction of everything below is unchanged; only the threshold moves.)

    A structural tool trades one against the other: it INJECTS a large answer (cache writes go up) in order to
    REMOVE turns (cache reads go down). So it is cheaper if and only if

        delta_write / -delta_read  <  P_read / P_write  =  1/20

    In words: **every extra token a tool puts into the context must remove twenty tokens of re-reading.**
    That is a hard bar, and it gets HARDER the better the tool is at its job — because the turns it saves are
    exactly the turns over which its own payload would have amortised. A tool that answers in one call pays
    full price for its answer and gets no amortisation at all.

    This is why "fewer tool calls" and "lower token cost" are not the same axis, and why the first does not
    imply the second."""
    if base not in means: return
    pw, pr = PRICE["cacheCreationInputTokens"], PRICE["cacheReadInputTokens"]
    print("\n══ WHY IT DOES NOT GET CHEAPER — the break-even")
    print(f"   a tool is cheaper iff  d_write / -d_read  <  P_read/P_write = {pr/pw:.3f}"
          f"   (i.e. remove {pw/pr:.0f} tokens of re-read per token injected)")
    for a in means:
        if a == base: continue
        dw = means[a]["cacheCreationInputTokens"] - means[base]["cacheCreationInputTokens"]
        dr = means[a]["cacheReadInputTokens"] - means[base]["cacheReadInputTokens"]
        ratio = (dw / -dr) if dr < 0 else float("inf")
        verdict = "PASSES" if ratio < pr / pw else "FAILS"
        print(f"   {ARMS[a]:8} d_write {dw:+9.0f}  d_read {dr:+10.0f}  ratio "
              f"{ratio:7.3f}  {verdict} (needs < {pr/pw:.3f})")
        if dr < 0:
            print(f"            to break even it would have to remove {dw*pw/pr:,.0f} tokens of re-read; "
                  f"it removed {-dr:,.0f}")


def main():
    tf = truth_files()
    n_truth = len(tf[0]) + len(tf[1])
    rounds = sys.argv[1:] or sorted({os.path.basename(f).split(".")[0]
                                     for f in glob.glob(os.path.join(OUT, "*.jsonl"))})
    rows = {a: [] for a in ARMS}
    print(f"ground truth: {n_truth} files ({len(tf[1])} wildcard)\n")
    hdr = f"{'run':14}{'calls':>6}{'turns':>6}{'think':>7}{'out':>7}{'cwrite':>8}{'cread':>9}{'$':>7}{'wall':>6}{'api':>6}{'eng':>6}{'F1':>6}{'rec':>6}"
    print(hdr); print("-" * len(hdr))
    for rd in rounds:
        for a in ARMS:
            p = os.path.join(OUT, f"{rd}.{a}.jsonl")
            if not os.path.exists(p): continue
            r = measure(p); s = score(r, tf); r.update(s); r["round"] = rd
            r["dirty"], r["blocked"] = contamination(p, a); rows[a].append(r)
            print(f"{rd+'.'+a:14}{r['tool_calls']:>6}{r['turns']:>6}{r['think_tok']:>7}"
                  f"{r['outputTokens']:>7}{r['cacheCreationInputTokens']:>8}{r['cacheReadInputTokens']:>9}"
                  f"{r['cost']:>7.3f}{r['wall']:>6}{r['api']:>6.0f}{r['engine']:>6.0f}"
                  f"{s['f1']*100:>5.0f}%{s['rec']*100:>5.0f}%"
                  + ("  DIRTY:%d" % len(r["dirty"]) if r["dirty"] else "")
                  + ("  blocked:%d" % len(r["blocked"]) if r["blocked"] else ""))
        print()
    for a in rows:
        for x in rows[a]: x["blocked_n"] = len(x["blocked"])
    keys = ["tool_calls","blocked_n","turns","think_tok","text_tok","outputTokens","cacheCreationInputTokens",
            "cacheReadInputTokens","inputTokens","cost","wall","api","engine","prec","rec","f1","denials"]
    means = {a: {k: st.mean(x[k] for x in rows[a]) for k in keys} for a in ARMS if rows[a]}
    if not means: return
    dirty = [(a, x["round"], c) for a in rows for x in rows[a] for c in x["dirty"]]
    if dirty:
        print("\n══ CONTAMINATION — these rounds are NOT clean and must not be averaged in as they stand")
        for a, rd, c in dirty: print(f"   {rd}.{a}  {c}")
    print("\n══ MEANS" + f"   n={ {a: len(rows[a]) for a in means} }")
    w = f"{'metric':26}" + "".join(f"{ARMS[a]:>12}" for a in means)
    print(w); print("-" * len(w))
    for k in keys:
        print(f"{k:26}" + "".join(f"{means[a][k]:>12.2f}" for a in means))
    base = "A"
    if base in means:
        print("\n══ COST DECOMPOSITION vs GREP ($/run, billed prices)")
        for a in means:
            if a == base: continue
            print(f"  {ARMS[a]} - GREP")
            tot = 0
            for k, px in PRICE.items():
                d = (means[a][k] - means[base][k]) * px; tot += d
                print(f"    {k:28}{d:+10.4f}")
            print(f"    {'TOTAL':28}{tot:+10.4f}   ({means[a]['cost']/means[base]['cost']:.2f}x)")
        breakeven(means, base)
    print("\n══ THE VERIFICATION FLOOR — cost before vs after the answer was complete")
    print(f"   (split at call {6}, where arm C's oracle prints DONE; same index for the others)")
    for a in ARMS:
        if not rows[a]: continue
        sp = [verification_split(os.path.join(OUT, f"{x['round']}.{a}.jsonl"), a) for x in rows[a]]
        pre = st.mean(x[0] for x in sp); post = st.mean(x[1] for x in sp); aft = st.mean(x[2] for x in sp)
        share = post / (pre + post) * 100 if pre + post else 0
        print(f"   {ARMS[a]:8} before ${pre:.3f}   after ${post:.3f}   ({share:.0f}% of the run)"
              f"   calls after: {aft:.1f}")

main()
