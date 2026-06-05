#!/usr/bin/env bash
#
# Find good Seam test commits in a squash-merge repo: recent single-commit PRs in
# the "medium, multi-intent" review sweet spot — enough files/directories to have
# several seams, but not a 50-file monster. Run from inside the cloned repo.
#
#   ~/dev/code-review-sort/find-review-candidates.sh [N]   # scan last N commits (default 200)
#
# Output (most files first):  <files> files · <dirs> dirs · <hash> · <subject>
# Pick one that spans a few directories and reads like a feature/refactor (not a
# dep bump / version / typo), then: review-commit.sh <hash>
set -euo pipefail

N="${1:-200}"
# Exclude noise that inflates file counts but isn't reviewed by hand.
EXCL=(':(exclude)*lock*' ':(exclude)*.snap' ':(exclude)**/generated/**'
      ':(exclude)*.min.*' ':(exclude)pnpm-lock.yaml' ':(exclude)*.lock')

git log --no-merges -n "$N" --pretty=format:'%H' | while read -r h; do
  files=$(git show --stat --format= "$h" -- . "${EXCL[@]}" 2>/dev/null | grep -c '|' || true)
  [ -z "$files" ] && continue
  if [ "$files" -ge 6 ] && [ "$files" -le 30 ]; then
    dirs=$(git show --name-only --format= "$h" -- . "${EXCL[@]}" 2>/dev/null \
            | sed 's:/[^/]*$::' | sort -u | grep -c . || true)
    subj=$(git show -s --format='%s' "$h")
    printf '%3d files · %2d dirs · %s · %s\n' "$files" "$dirs" "${h:0:10}" "$subj"
  fi
done | sort -rn | head -25
