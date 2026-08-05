#!/usr/bin/env bash
# PRE-WARM an isolated benchmark cache by REPLAYING the Seam commands previous runs actually issued.
#
# WHY REPLAY AND NOT A HAND-PICKED ANCHOR (measured, kc12, 2026-08-03). Isolating the cache with
# SEAM_REPO_CACHE_DIR removed the contamination it was meant to remove — and every bit of legitimate warmth
# with it. A real user's repo cache is warm across the anchors they have touched; a fresh root warmed on ONE
# anchor is not. kc12's arm-SEAM engine time came out 111.6 / 120.9 / 32.7s against kc8's 20.4 / 22.6 / 62.7s
# on a shared warm cache — the "clean" protocol charged the treatment arm for cold-path work no real
# invocation pays, the mirror image of the bias this harness exists to prevent.
#
# So the warm-up is derived from EVIDENCE: replay the `decompose.ts` invocations stored transcripts contain.
# That covers what an agent actually reaches for on this case, not what the harness author guessed.
#
#   SEAM_REPO_CACHE_DIR=... ./prewarm.sh <repo> <transcript.jsonl>...
set -u
REPO="${1:?usage: prewarm.sh <repo> <transcript.jsonl>...}"; shift
HERE="$(cd "$(dirname "$0")" && pwd)"
SEAM="$(cd "$HERE/../.." && pwd)/ts/src/cli/decompose.ts"
: "${SEAM_REPO_CACHE_DIR:?SEAM_REPO_CACHE_DIR must be set — warming the shared repo cache defeats the point}"
n=0
while IFS= read -r body; do
  [ -n "$body" ] || continue
  # shellcheck disable=SC2086 — the flags must word-split; they come from our own stored transcripts
  timeout 900 bun "$SEAM" $body >/dev/null 2>&1
  n=$((n + 1))
done < <(python3 "$HERE/extract_seam_cmds.py" "$@")
echo "  pre-warm: replayed $n Seam invocation(s) into $SEAM_REPO_CACHE_DIR"
