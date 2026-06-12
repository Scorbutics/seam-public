#!/usr/bin/env bash
# Offline smoke test: every checked-in diff must decompose under the fully-deterministic
# engine (--classifier det) — no `claude`, no network, no API key. This is the floor that
# proves the engine itself runs on a bare machine. Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."

out=$(mktemp)
trap 'rm -f "$out"' EXIT
fail=0

run() {
  local patch="$1"
  printf '── %-42s ' "$patch"
  if bun ts/src/cli/decompose.ts --file "$patch" --classifier det --format ascii >"$out" 2>&1; then
    # Echo the one-line seam summary so the log shows WHAT it produced, not just "ok".
    summary=$(grep -m1 -E '^Seam ' "$out" || true)
    echo "ok   ${summary:-(no summary line)}"
  else
    echo "FAIL"
    sed 's/^/    /' "$out"
    fail=1
  fi
}

run sample.patch
shopt -s nullglob
for p in samples/*.patch; do
  run "$p"
done

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ offline smoke passed — the engine decomposes every sample diff with zero setup."
else
  echo "✗ offline smoke FAILED — see above."
fi
exit "$fail"
