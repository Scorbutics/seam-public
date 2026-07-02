#!/usr/bin/env bash
# AGENT-GROW BENCH (plan §5.2) — the product claim, made measurable and honest: on a real repo, is
#   (a) one shallow grow + one deepening + the agent render
# faster + more complete than
#   (b) the grep loop a competent agent would run for the same intent?
#
# NOT CI-gated (needs a real repo + wall-clock timing). Re-runnable:
#   REPO=~/dev/private-app INTENT="how does a member subscribe …" ANCHOR="app/subscribe/page.tsx#SubscribePage" \
#     GREPS="subscribe|checkout|stripe|price|webhook" bash ts/eval/agent-grow-bench.sh
# Commit the printed numbers to ts/eval/grow-phase1-matrix.md. Report where grep WINS too (single-fact
# lookups) — the README's routing guidance stays honest.
set -u
cd "$(dirname "$0")/.."   # ts/eval → ts
REPO="${REPO:?set REPO=<path to a real repo>}"
INTENT="${INTENT:?set INTENT=<the natural-language question>}"
ANCHOR="${ANCHOR:-}"                          # optional file#symbol for the shallow grow (else --auto)
GREPS="${GREPS:-}"                            # pipe-separated terms a human agent would grep for
CLI="bun src/cli/decompose.ts"
now() { date +%s%3N; }

echo "=== (a) SEAM: shallow grow + deepen + agent render ==="
t0=$(now)
if [ -n "$ANCHOR" ]; then
  SEAM_GROW_WAVE=1 SEAM_TIER_GROW=1 SEAM_HUB_COLLAPSE=1 $CLI --repo "$REPO" --grow-from "$ANCHOR" --intent "$INTENT" \
    --format agent --token-budget 4000 --emit-seams /tmp/bench_seam.json >/tmp/bench_agent.txt 2>/dev/null
else
  SEAM_GROW_WAVE=1 SEAM_TIER_GROW=1 SEAM_HUB_COLLAPSE=1 $CLI --repo "$REPO" --scan --auto --intent "$INTENT" \
    --format agent --token-budget 4000 --emit-seams /tmp/bench_seam.json >/tmp/bench_agent.txt 2>/dev/null
fi
t1=$(now)
# one deepening from the top frontier point (the real agent loop: read → deepen a decision point)
DEEP=$(python3 -c "import json;m=json.load(open('/tmp/bench_seam.json'));f=(m.get('frontier') or [{}])[0];print(f.get('file','')+'#'+f.get('symbol','') if f.get('symbol') else '')" 2>/dev/null)
t2=$(now)
if [ -n "$DEEP" ] && [ "$DEEP" != "#" ]; then
  SEAM_GROW_WAVE=1 SEAM_TIER_GROW=1 SEAM_HUB_COLLAPSE=1 $CLI --repo "$REPO" --grow-from "$DEEP" --intent "$INTENT" \
    --format agent --token-budget 2000 >/tmp/bench_deep.txt 2>/dev/null
fi
t3=$(now)
seam_tok=$(( ( $(wc -c </tmp/bench_agent.txt 2>/dev/null || echo 0) + $(wc -c </tmp/bench_deep.txt 2>/dev/null || echo 0) ) / 4 ))
echo "  grow+render wall: $((t1-t0))ms | deepen wall: $((t3-t2))ms | output ~${seam_tok} tokens (chars/4)"
echo "  frontier deepened: ${DEEP:-<none>}"

echo "=== (b) GREP LOOP: the greps a competent agent would run ==="
if [ -n "$GREPS" ]; then
  t0=$(now); hits=0
  IFS='|' read -ra TERMS <<< "$GREPS"
  for term in "${TERMS[@]}"; do
    n=$(grep -rIl -E "$term" "$REPO" --include='*.ts' --include='*.js' --include='*.py' --include='*.java' --include='*.rb' 2>/dev/null | wc -l)
    hits=$((hits+n)); echo "  grep '$term' → $n file(s)"
  done
  t1=$(now)
  echo "  grep loop wall: $((t1-t0))ms | ${hits} file-hits across ${#TERMS[@]} greps — a FLAT list, no crossings/spine/provenance"
else
  echo "  (set GREPS='term1|term2|…' to time the comparison loop)"
fi

echo
echo "Honest note: grep WINS for single-fact lookups (one symbol, find-usages) — instant, no model."
echo "Seam wins when the answer is a PATH/FLOW across value-level crossings (route/table/queue) the grep"
echo "loop structurally cannot connect. Record both, per ts/eval/grow-phase1-matrix.md."
