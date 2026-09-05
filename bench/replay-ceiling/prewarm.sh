#!/usr/bin/env bash
# WARM THE CACHE BY REPLAY, not by a hand-picked anchor.
#
# The cache is keyed on the core's build stamp, so the FIRST run after any `cargo build` pays a full floor +
# footprint rebuild. Measuring arm B right after a rebuild measures the BUILD, not the tool — and a per-run
# cold cache charges the treatment arm for first-run cost no real invocation pays. bench/grep-vs-seam settled
# this: replay the commands PREVIOUS runs actually issued, so the cache holds what an agent reaches for on
# this case rather than what the harness author guessed. `prewarm-cmds.txt` is those commands, extracted from
# the six recorded kcC Seam transcripts.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
export REPO="${REPO:-$HOME/dev/keycloak}" SEAM="$ROOT/ts/src/cli/decompose.ts"
export SEAM_REPO_CACHE_DIR="${SEAM_REPO_CACHE_DIR:-/tmp/seam-bench-cache}"
mkdir -p "$SEAM_REPO_CACHE_DIR"
n=0
while IFS= read -r cmd; do
  [ -z "$cmd" ] && continue
  n=$((n+1)); s=$(date +%s)
  eval "$cmd" >/dev/null 2>&1
  echo "  [$n] $(( $(date +%s) - s ))s  ${cmd:0:110}"
done < "$HERE/prewarm-cmds.txt"
echo "prewarm: $n command(s)"
