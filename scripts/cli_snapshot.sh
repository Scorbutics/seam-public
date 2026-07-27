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
  SEAM_GRAPH_CACHE=0 timeout 300 bun src/cli/decompose.ts "$@" >"$OUT/$name.out" 2>"$OUT/$name.err"
  echo "$?" >"$OUT/$name.code"
  # the .seam cache path and timings vary per run; strip them so the diff is about ANSWERS
  sed -i -E 's|/tmp/[a-zA-Z0-9_.-]+||g; s/[0-9]+(\.[0-9]+)?(ms|s)\b/T/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+/D/g' "$OUT/$name.out" "$OUT/$name.err"
  sed -i -E 's/^(\[route:[a-z]+\]).*/\1/' "$OUT/$name.out"
}
run grow        --repo "$R" --scan --auto --intent "how is a payment persisted" --anchor-file "$A" --symbol "$S" --data-coupling floor
run concern     --repo "$R" --scan --auto --intent "how is a payment persisted" --anchor-file "$A" --symbol "$S" --concern --data-coupling floor --format concern
run growfrom    --repo "$R" --scan --auto --intent "how is a payment persisted" --grow-from "$A#$S" --data-coupling floor
run diff        --repo "$R" --file ../sample.patch
for q in set impact contract neighborhood compare reach refactor writers coupling dependencies; do
  run "q_$q" --repo "$R" --scan --query "$q" --anchor-file "$A" --symbol "$S" --data-coupling floor
done
# The two paths a shape-only sweep MISSES, and the reason a deletion once looked safe when it wasn't:
# name-grounded recall (--recall name) and the NL router (--query ask). Offline, `ask` takes the no-backend
# branch — which still exercises the routing entry point, so a broken wire shows up as a changed message.
run q_recall    --repo "$R" --scan --query consumers --anchor-file "$A" --symbol "$S" --recall name --data-coupling floor
run q_ask       --repo "$R" --scan --query ask --ask "who calls $S" --data-coupling floor
echo "snapshot: $OUT ($(ls "$OUT" | wc -l) files)"
