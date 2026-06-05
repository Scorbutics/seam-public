#!/usr/bin/env bash
#
# Stage a squashed-PR commit into the WORKING TREE (vs its parent) so Seam's
# working-tree review — the path with aligned decorations — can review it as if it
# were your own uncommitted changes. This sidesteps the (still-WIP) commit-review
# mode: the new-side lines then match the worktree exactly.
#
#   ~/dev/code-review-sort/review-commit.sh <commit>
#
# Then in VS Code: Seam → "Review working changes".
# Undo when done:  git cherry-pick --abort 2>/dev/null; git reset --hard; git switch -
set -euo pipefail

c="${1:?usage: review-commit.sh <commit>}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree not clean — commit/stash first." >&2; exit 1
fi

git switch --detach "${c}~"
# Apply the commit's diff to the worktree, then UNSTAGE it: `git diff HEAD` then
# shows it as working-tree changes, so the diff's modified side is the working file
# (file:) — which Seam decorates cleanly (staged/index diffs are git: and harder).
git cherry-pick --no-commit "$c"
git reset -q                       # keep worktree changes, but unstage them

echo
echo "✓ Worktree now holds $(git rev-parse --short "$c") vs its parent (unstaged)."
echo "  In VS Code: Seam icon → Review working changes."
echo "  Undo: git cherry-pick --abort 2>/dev/null; git reset --hard; git switch -"
