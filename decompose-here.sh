#!/usr/bin/env bash
#
# Run the decompose report against the repo you're currently standing in.
#
# Usage:
#   decompose-here.sh [REF]
#
#   REF can be:
#     - omitted, or "working"/"uncommitted"/"dirty" -> the current uncommitted
#       changes (working tree vs HEAD, i.e. `git diff HEAD`); no commit needed
#     - a single commit (e.g. 6f16795 or HEAD) -> reviewed as REF~..REF
#     - a full range containing ".." (e.g. main..HEAD, abc~..abc) -> used as-is
#
# Examples:
#   decompose-here.sh                 # review current uncommitted changes
#   decompose-here.sh working         # same, explicitly
#   decompose-here.sh HEAD            # review the latest commit (HEAD~..HEAD)
#   decompose-here.sh 6f16795         # review that single commit
#   decompose-here.sh main..HEAD      # review a range
#
# Any extra args after REF are passed straight through to decompose.py,
# e.g. decompose-here.sh HEAD --model claude-sonnet-4-6 --verbose
set -euo pipefail

# Directory where code-review-sort (and its .venv) lives.
TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The repo to analyze is wherever the user invoked this script from.
REPO_DIR="$PWD"

REF="${1:-working}"
# Drop REF from the argument list so the rest can be forwarded as-is.
[ "$#" -gt 0 ] && shift || true

# Resolve REF into a git-diff target:
#   - working/uncommitted/dirty -> "HEAD" alone, so `git diff HEAD` shows the
#     working tree (uncommitted tracked changes) without needing a commit.
#   - an explicit range (".." ) is used as-is.
#   - any other bare ref is expanded into a single-commit range REF~..REF.
case "$REF" in
  working|uncommitted|dirty) RANGE="HEAD" ;;
  *..*)                      RANGE="$REF" ;;
  *)                         RANGE="${REF}~..${REF}" ;;
esac

cd "$TOOL_DIR"
# shellcheck disable=SC1091
source .venv/bin/activate
exec python decompose.py --git "$RANGE" --repo "$REPO_DIR" --open "$@"
