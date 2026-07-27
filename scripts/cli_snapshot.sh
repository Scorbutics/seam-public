#!/usr/bin/env bash
# CLI OUTPUT SNAPSHOT — the gate for deleting bypassed TypeScript.
#
# A deletion is safe when the product's OUTPUT does not move. Coverage says which code no longer runs; this
# says whether removing it changed any answer. Run it before a cut and after, and diff the two directories:
# byte-identical means the deleted code was genuinely bypassed, on every path listed here.
#
#   scripts/cli_snapshot.sh before        # capture the baseline
#   ...delete something...
#   scripts/cli_snapshot.sh after && diff -r /tmp/seam-snap/before /tmp/seam-snap/after
#
# The paths below are the product surface, not a sample: a grow, every shape, a concern grow, a deepen, and
# diff mode. Anything NOT exercised here is outside the guarantee — add a case rather than assume.
set -u
OUT="/tmp/seam-snap/${1:?usage: cli_snapshot.sh <before|after>}"
rm -rf "$OUT"; mkdir -p "$OUT"
cd "$(dirname "$0")/../ts" || exit 1
R="test/fixtures/route-repo"
A="backend/persist.ts"; S="persistPayment"
run() { # run <name> <args...>
  local name="$1"; shift
  SEAM_GRAPH_CACHE=0 SEAM_EMBED_QUANTIZED="${SEAM_EMBED_QUANTIZED:-}" timeout 300 bun src/cli/decompose.ts "$@" >"$OUT/$name.out" 2>"$OUT/$name.err"
  echo "$?" >"$OUT/$name.code"
  # the .seam cache path and timings vary per run; strip them so the diff is about ANSWERS
  sed -i -E 's|/tmp/[a-zA-Z0-9_.-]+||g; s/[0-9]+(\.[0-9]+)?(ms|s)\b/T/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+/D/g' "$OUT/$name.out" "$OUT/$name.err"
  sed -i -E 's/^(\[route:[a-z]+\]).*/\1/' "$OUT/$name.out"
}
run grow        --repo "$R" --scan --auto --intent "how is a payment persisted" --anchor-file "$A" --symbol "$S" --data-coupling floor
run concern     --repo "$R" --scan --auto --intent "how is a payment persisted" --anchor-file "$A" --symbol "$S" --concern --data-coupling floor --format concern
run growfrom    --repo "$R" --scan --auto --intent "how is a payment persisted" --grow-from "$A#$S" --data-coupling floor
run diff        --repo "$R" --file ../sample.patch
# CENTER-FIRST concern (no --center): the ONE path that runs the intent-weighted center pick, and therefore
# the only one that exercises embedScoreDefs. Every other case pins the anchor, which skips it entirely.
run centerfirst --repo "$R" --scan --auto --concern --intent "how is a payment persisted" --data-coupling floor --format concern
for q in set impact contract neighborhood compare reach refactor writers coupling dependencies; do
  run "q_$q" --repo "$R" --scan --query "$q" --anchor-file "$A" --symbol "$S" --data-coupling floor
done
# The two paths a shape-only sweep MISSES, and the reason a deletion once looked safe when it wasn't:
# name-grounded recall (--recall name) and the NL router (--query ask). Offline, `ask` takes the no-backend
# branch — which still exercises the routing entry point, so a broken wire shows up as a changed message.
# DEPTH 2 — the environment ripple (each exported depth-1 consumer's own importers). Depth 1 is every other
# case here, so without this the ripple is entirely outside the guarantee.
# MODULE MODE (--center <file>, no #symbol). Every other case here pins a SYMBOL, so the whole-file coupling
# overlay — which is what a module anchor's answer mostly IS — was outside the guarantee. It regressed from 7
# symbols to 2 while the render still said "resolution: FULL", and nothing here noticed.
run module      --repo "$R" --scan --anchor-file "$A" --data-coupling floor
run q_contract2 --repo "$R" --scan --query contract --anchor-file "$A" --data-coupling floor
run q_depth2    --repo "$R" --scan --anchor-file "$A" --symbol "$S" --depth 2 --data-coupling floor
run q_depth1    --repo "$R" --scan --anchor-file "$A" --symbol "$S" --depth 1 --data-coupling floor
# --expand-graph: build a graph, then expand it from a second anchor and merge. Two core calls plus the merge,
# and the one path that reads a graph the engine WROTE rather than one it just built.
SEAM_GRAPH_CACHE=0 timeout 300 bun src/cli/decompose.ts --repo "$R" --scan --anchor-file "$A" --symbol "$S" \
  --emit-graph "$OUT/graph.json" --data-coupling floor >/dev/null 2>&1
run expand      --repo "$R" --scan --expand-graph "$OUT/graph.json" --expand-file "$A" --expand-symbol "$S" --data-coupling floor
rm -f "$OUT/graph.json"
# --emit-candidates: the CLASS-anchor LSP hand-off. It writes a JSON file rather than stdout, so cat it into
# the snapshot — the candidate list IS the answer here.
SEAM_GRAPH_CACHE=0 timeout 300 bun src/cli/decompose.ts --repo test/fixtures/method-repo --scan \
  --anchor-file src/engine.ts --symbol Engine --emit-candidates "$OUT/cand.json" >"$OUT/candidates.out" 2>"$OUT/candidates.err"
echo "$?" >"$OUT/candidates.code"
cat "$OUT/cand.json" >>"$OUT/candidates.out" 2>/dev/null; rm -f "$OUT/cand.json"
sed -i -E 's|/tmp/[a-zA-Z0-9_./-]+||g' "$OUT/candidates.out" "$OUT/candidates.err"   # the emit path names $OUT
run q_recall    --repo "$R" --scan --query consumers --anchor-file "$A" --symbol "$S" --recall name --data-coupling floor
run q_ask       --repo "$R" --scan --query ask --ask "who calls $S" --data-coupling floor
echo "snapshot: $OUT ($(ls "$OUT" | wc -l) files)"
