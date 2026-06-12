#!/usr/bin/env bash
# Clean-room gate (AI feedback, point 2): build a vanilla Docker image that installs bun fresh
# and runs the documented one-liner (`make vsix` + `make smoke` + `make test`) from zero. The
# build context excludes every node_modules/dist/out (see .dockerignore), so "works on my
# machine" assumptions — a warm PATH, a pre-installed dep — cannot mask a missing step here.
#
# It tests your WORKING TREE (uncommitted changes included), which is what you want before a
# release. Needs Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found — the clean-room test needs Docker. Install it, or run 'make ci' for the native checks." >&2
  exit 1
fi

img=seam-cleanroom
echo "Building clean-room image '$img' (vanilla Debian + fresh bun, no host deps)…"
echo "This installs everything from zero, so the first run is slow."
echo

docker build --progress=plain -f Dockerfile.cleanroom -t "$img" .

echo
echo "✓ Clean-room passed — Seam installs and runs from zero on a bare machine."
echo "  (make vsix + make smoke + make test all succeeded inside the container)"
