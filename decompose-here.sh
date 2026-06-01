#!/usr/bin/env bash
#
# Run the decompose report against the repo you're currently standing in.
#
# Usage:
#   decompose-here.sh [REF]
#
#   REF can be:
#     - a single commit (e.g. 6f16795 or HEAD) -> reviewed as REF~..REF
#     - a full range containing ".." (e.g. main..HEAD, abc~..abc) -> used as-is
#     - omitted -> defaults to HEAD (the last commit)
#
# Examples:
#   decompose-here.sh                 # review the latest commit (HEAD~..HEAD)
#   decompose-here.sh 6f16795         # review that single commit
#   decompose-here.sh main..HEAD      # review a range
#
# Any extra args after REF are passed straight through to decompose.py,
# e.g. decompose-here.sh HEAD --model claude-sonnet-4-6 --verbose
set -euo pipefail

# Directory where code-review-sort (and its .venv) lives.
TOOL_DIR="/home/scorbutics/dev/code-review-sort"

# The repo to analyze is wherever the user invoked this script from.
REPO_DIR="$PWD"

REF="${1:-HEAD}"
# Drop REF from the argument list so the rest can be forwarded as-is.
[ "$#" -gt 0 ] && shift || true

# Expand a bare commit into a single-commit range; leave explicit ranges alone.
case "$REF" in
  *..*) RANGE="$REF" ;;
  *)    RANGE="${REF}~..${REF}" ;;
esac

cd "$TOOL_DIR"
# shellcheck disable=SC1091
source .venv/bin/activate
exec python decompose.py --git "$RANGE" --repo "$REPO_DIR" --open "$@"
