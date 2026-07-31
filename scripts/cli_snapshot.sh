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
#
# AND "exercised" is not the same as "asserted". A case whose answer is "none resolved" runs the flag and
# pins an EMPTY result, so every line of logic behind it is still unguarded — which is exactly how the DI
# code path stayed invisible while `--query dependencies` sat in this file. An audit of what each path's
# output actually contains found: 1 case failing argument validation (compare, for the whole migration),
# 7 cases answering nothing, and 5 cases byte-identical to each other. Hence the `b_*` family below, which
# re-runs the query shapes against an anchor that has real fan-out.
#
# That hole is CLOSED: `test/fixtures/writers-repo` is a reader plus two writers (one create, one update) of
# the same table, so `--query writers` and the coupling counterpart set both have something to answer. It was
# real: no natural fixture yielded a non-empty writers set (booking-app has a shared key with zero counterpart
# sites), so q_writers pinned "reads no resolvable DB table" and the whole reverse-coupling shape sat outside
# the guarantee while its case looked covered.
set -u
OUT="/tmp/seam-snap/${1:?usage: cli_snapshot.sh <before|after>}"
rm -rf "$OUT"; mkdir -p "$OUT"
cd "$(dirname "$0")/../ts" || exit 1
# COLD-START THE RUST-SIDE FIXTURE CACHES.
#
# Found the hard way: SEAM_GRAPH_CACHE=0 does NOT disable the coupling floor-index cache, which lives in each
# fixture's `.seam/rust/`. A fixture that kept one between runs served the index from disk, so a change to the
# code BEHIND it produced no output change and this gate reported byte-identical. Verified: deleting "update"
# from the db-table adapter's WRITE_VERBS was invisible with the cache present (2 write sites either way) and
# caught immediately without it (2 -> 1). A gate that cannot see a code change is not a gate.
#
# Only the UNTRACKED `.seam/rust/` indices are removed. The tracked `.seam/*.json` fixtures stay (tests assert
# on them), and nothing outside test/fixtures is touched -- in particular never node_modules, which holds the
# downloaded embedding model.
find test/fixtures -maxdepth 3 -type d -name rust -path '*/.seam/*' -prune -exec rm -rf {} + 2>/dev/null
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
# `--locate <name>` — the address lookup an agent runs BEFORE any shape, and which this gate did not cover at
# all. A silent regression here poisons every query downstream, because the caller anchors on what it returns.
# (Its intent-phrase sibling was tried and DELETED — see bench/anchor-select/README.md: lexical matching cannot
# be the basis of a structural command.)
run locate      --repo "$R" --locate persistPayment
# `--format agent` — THE FORMAT THIS GATE DID NOT COVER AT ALL. Its own header calls it "the region to read
# instead of a grep loop", the README calls it the primary agent surface, and there was not one case for it: a
# change that added source snippets to every region/entry/sink line came back byte-identical here, because the
# gate never rendered it. A green diff on an unexercised surface is not a guarantee, it is the absence of one —
# the same shape as the contract cases that all answered `provides: 0`, and the writers case that pinned an
# empty set. TWO anchors on purpose: one WITH a mechanism (the pipeline section, which was the only place
# snippets used to appear) and one with region/entry sections only (where there were none).
run agent       --repo "$R" --scan --auto --intent "how is a payment persisted" --anchor-file "$A" --symbol "$S" --data-coupling floor --format agent
run agent_noflow --repo test/fixtures/crossstack-repo --scan --auto --intent "who reads the orders table" --anchor-file lib/db.ts --symbol supabase --data-coupling floor --format agent
# CENTER-FIRST concern (no --center): the ONE path that runs the intent-weighted center pick, and therefore
# the only one that exercises embedScoreDefs. Every other case pins the anchor, which skips it entirely.
run centerfirst --repo "$R" --scan --auto --concern --intent "how is a payment persisted" --data-coupling floor --format concern
# `set` and `reach` ARE NOT SHAPES. The registered handlers are `consumers` and `reaches` (decompose.ts
# QUERY_HANDLERS), so `--query set` / `--query reach` matched nothing, fell through to a GROW, and these two
# cases pinned a grow's output under a shape's name -- byte-identical to each other and to `q_depth1`. The
# consumers shape (the most-used shape in the product) and the reaches shape therefore had NO gate coverage at
# all, for the whole migration, while two cases made them look covered. Third instance of this file's own
# null-answer trap found in one day; the first two were the contract shape's empty `provides` and the DI query.
# `reaches` is NOT in the loop for the same reason `compare` is not: it needs `--to-symbol`, so a loop case
# would pin an argument-validation error. Both get explicit cases below.
for q in consumers impact contract neighborhood refactor writers coupling dependencies; do
  run "q_$q" --repo "$R" --scan --query "$q" --anchor-file "$A" --symbol "$S" --data-coupling floor
done
# `compare` is NOT in that loop: it needs a side B. It used to be, and so it exited 2 on
# "--query compare requires --to-symbol and --to-file" every single run — the gate was pinning an
# ARGUMENT-VALIDATION ERROR, and the compare shape itself (runCompare + renderComparison) had zero coverage
# for the whole migration. Found by auditing what each path's output actually asserts.
# ...and on booking-app, because on route-repo NEITHER side has resolved dependencies, so the fixed case
# still answered "nothing to compare" — the same null-answer trap one level down.
run q_compare   --repo test/fixtures/booking-app --scan --query compare \
  --anchor-file ejb/BookingsBean.java --symbol BookingsBean \
  --to-file rest/BookingsService.java --to-symbol BookingsService --data-coupling floor
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
# CONTRACT with a NON-EMPTY `provides`. Every other contract case here answers `provides: 0` — measured, all
# three — so the entire "## Provides" block, and with it the declared-signature and observed-call-site halves
# of the shape, sat OUTSIDE the guarantee while three cases made it look covered. Exactly the null-answer trap
# this file's header warns about, found again by adding the enrichment and watching the gate not move.
# Two centers, because the two report DIFFERENT things and one alone would pin only half:
#   chain-repo/src/b.ts   — a plain funclike export: declared signature + a real call site with an arity bucket
#   crossstack-repo/lib/db.ts — an exported client OBJECT: no signature, never called, used as a RECEIVER
#     (`supabase.from(…)`) by 4 files. This case caught two live bugs: a bogus `(t)` signature read off an
#     inner property, and "imported but never invoked" asserted about a symbol used at 4 sites.
run q_contract_provides --repo test/fixtures/chain-repo --scan --query contract --anchor-file src/b.ts --data-coupling floor
run q_contract_recv     --repo test/fixtures/crossstack-repo --scan --query contract --anchor-file lib/db.ts --data-coupling floor
# RE-EXPORT BARRELS. Added because this gate showed ZERO diffs for a fix that moved real counts on private-app: not one
# case in this file contained a barrel, so the whole mechanism sat outside the guarantee while the shapes it
# breaks were all "covered". `barrel-repo` makes each of the three forms the only path to a number — named
# (`export { x } from`), RENAMING (`export { a as b } from`, where the call sites spell `b`), and STAR
# (`export * from`, which names nothing at all and so was structurally invisible). See its README.
run q_contract_barrel  --repo test/fixtures/barrel-repo --scan --query contract --anchor-file src/decl.ts --data-coupling floor
# CONFIG-KEY COUPLING, across four languages. Added for the same reason as the barrel cases: this gate showed
# ZERO diffs when the config-key adapter was introduced, because no fixture here contains a shared environment
# variable. `bench/coupling/repo` is referenced rather than copied so the gate and the coupling benchmark cannot
# drift -- it is the only tree in the repo with a TS/Java/Ruby/Python key, and it also carries the SYMMETRIC-kind
# case (reader<->reader, where `other_side` unions both sides instead of returning the complement).
run q_coupling_config  --repo ../bench/coupling/repo --scan --query coupling \
                       --anchor-file api/notify.ts --symbol notifyUrl --data-coupling floor
run q_consumers_barrel --repo test/fixtures/barrel-repo --scan --query consumers \
                       --anchor-file src/decl.ts --symbol mapTasks --data-coupling floor
run q_depth2    --repo "$R" --scan --anchor-file "$A" --symbol "$S" --depth 2 --data-coupling floor
# ...and a case where --depth ACTUALLY CHANGES THE ANSWER. It does not above: measured, q_depth1, q_depth2,
# q_reach, q_set and expand are all BYTE-IDENTICAL, so the "environment ripple" the comment above claims to
# cover was never observable. On the fixtures the raw footprint closure saturates at depth 1 whatever the
# flag says; `neighborhood` is where depth is visible (it passes --depth straight through, queries.ts:458).
# Measured on booking-app/BookingsBean: depth 1 -> 3 core files / 1 expanded, depth 3 -> 8 / 18.
# (the depth-1 half of this pair is `b_neighborhood` above — the same command at the default depth. Kept as
# one case, not two: measured byte-identical, and a gate case that duplicates another asserts nothing new.)
run q_depth_n3  --repo test/fixtures/booking-app --scan --query neighborhood \
  --anchor-file ejb/BookingsBean.java --symbol BookingsBean --depth 3 --data-coupling floor
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
# THE SAME QUERY FAMILY ON AN ANCHOR THAT HAS STRUCTURE.
#
# Measured: on route-repo/persistPayment, SEVEN of the query paths answer NOTHING — "none resolved",
# "isolated", "no resolved callers", "impact 0 across 0 file(s)". route-repo has no anchor with more than
# three consumers, so those paths run the flag and assert an empty answer, exactly the way --query
# dependencies hid the DI code path. booking-app/BookingsBean has real fan-out (impact 5 across 2 files,
# 2 resolved dependencies, a 3-file subsystem), so these cases assert content rather than absence.
for q in consumers impact contract neighborhood refactor coupling dependencies; do
  run "b_$q" --repo test/fixtures/booking-app --scan --query "$q" \
    --anchor-file ejb/BookingsBean.java --symbol BookingsBean --data-coupling floor
done
# CONSUMERS with a NON-ZERO answer, and REACHES with a real target -- the two shapes the `set`/`reach` typo
# left uncovered. crossstack-repo's `supabase` is imported by 4 files, so the consumer-EDGE count is non-zero
# and the header's counting unit is actually observable (every other consumers case in this file answers 0,
# which is how the "usage sites" -> "consumer edges" mislabel survived: no gate output contained a count).
run q_consumers_nz --repo test/fixtures/crossstack-repo --scan --query consumers \
  --anchor-file lib/db.ts --symbol supabase --data-coupling floor
run q_reaches      --repo test/fixtures/chain-repo --scan --query reaches \
  --anchor-file src/c.ts --symbol c --to-file src/a.ts --to-symbol a --data-coupling floor

# DI-BINDING ENRICHMENT on --query dependencies (default-ON via SEAM_DI_RESOLVE). The gate ALREADY ran that
# query — but only against route-repo, where the answer is "none resolved — a leaf", so the enrichment loop
# never iterated and the entire DI code path sat outside the guarantee while LOOKING covered. That path is
# the last TypeScript tree-sitter engine reachable on a default-on user query, so it needs a real case before
# it can be ported. `--format llm-context` because the default output is a one-line COUNT that renders no
# members at all; the four `↳ DI:` lines only appear there. Verified to bite: with SEAM_DI_RESOLVE=0 exactly
# those four lines disappear.
run q_di        --repo test/fixtures/di-repo --scan --query dependencies --anchor-file service.ts --symbol BookingService --format llm-context
# REVERSE DATA-COUPLING with a real answer: two write sites behind a table the anchor reads, no import or call
# edge linking them. llm-context because the one-line form prints a count, not the sites.
run w_writers   --repo test/fixtures/writers-repo --scan --query writers \
  --anchor-file src/reader.ts --symbol listBookings --data-coupling floor --format llm-context
run w_coupling  --repo test/fixtures/writers-repo --scan --query coupling \
  --anchor-file src/reader.ts --symbol listBookings --data-coupling floor --format llm-context
run q_recall    --repo "$R" --scan --query consumers --anchor-file "$A" --symbol "$S" --recall name --data-coupling floor
# ...on an anchor that HAS callers. The case above answers "no resolved callers" — name-grounded recall was
# being exercised against an empty consumer set, so the grounding step asserted nothing.
run b_recall    --repo test/fixtures/booking-app --scan --query consumers \
  --anchor-file ejb/BookingsBean.java --symbol persist --recall name --data-coupling floor
run q_ask       --repo "$R" --scan --query ask --ask "who calls $S" --data-coupling floor
echo "snapshot: $OUT ($(ls "$OUT" | wc -l) files)"
