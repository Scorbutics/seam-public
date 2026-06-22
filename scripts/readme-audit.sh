#!/usr/bin/env bash
# README command audit — runs the commands documented in README.md *verbatim*, against the
# checked-in fixtures (sample.patch, samples/, ts/src/...), so the docs can never drift from
# what actually works. This is the mechanical "every README command runs as-is" gate.
#
#   OFFLINE commands (--classifier det) always run — they need no model, no network.
#   MODEL   commands (default hybrid / llm passes) need a subscription-backed `claude` CLI;
#           they run when one is on PATH (or SEAM_AUDIT_LLM=1 is set), otherwise they are
#           SKIPPED with a visible notice (so CI stays green without a model, honestly).
#
# Keep this list in sync with README.md §"Install & run". If you change a documented command,
# change it here too — that coupling is the point.
set -uo pipefail
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
ran=0
skipped=0

# A model is available unless explicitly forced offline. SEAM_AUDIT_OFFLINE=1 emulates a
# CI runner (no model) even on a dev box that has `claude`.
have_model() {
  [ "${SEAM_AUDIT_OFFLINE:-}" = "1" ] && return 1
  [ "${SEAM_AUDIT_LLM:-}" = "1" ] || command -v claude >/dev/null 2>&1
}

# run <offline|model> <description> -- <command...>
run() {
  local kind="$1" desc="$2"; shift 3   # drop kind, desc, and the literal "--"
  if [ "$kind" = "model" ] && ! have_model; then
    printf '  ~ SKIP  %s  (needs a model CLI; none on PATH)\n' "$desc"
    skipped=$((skipped + 1)); return
  fi
  printf '  • %s\n      $ %s\n' "$desc" "$*"
  if "$@" >"$tmp/out" 2>&1; then
    ran=$((ran + 1))
  else
    printf '    ✗ FAILED (exit %d):\n' "$?"; sed 's/^/      /' "$tmp/out"
    fail=1
  fi
}

echo "README command audit"
echo "===================="

echo "-- Diff mode --"
run offline "diff, fully offline (det)" -- \
  bun ts/src/cli/decompose.ts --file sample.patch --classifier det --format ascii
run offline "emit the JSON contract (det)" -- \
  bun ts/src/cli/decompose.ts --file sample.patch --classifier det --emit-seams "$tmp/seams.json"
run offline "full-file tree-sitter AST facts (det)" -- \
  bun ts/src/cli/decompose.ts --file sample.patch --classifier det --facts-engine treesitter --format ascii
run offline "review-impact — cross-stack annotation on a diff" -- \
  bun ts/src/cli/decompose.ts --file ts/test/fixtures/crossstack-repo/charge.patch \
      --repo ts/test/fixtures/crossstack-repo --classifier det --review-impact
run model   "diff, default hybrid (LLM clusters)" -- \
  bun ts/src/cli/decompose.ts --file sample.patch --format ascii
run model   "mix per pass — det everything, LLM wiring" -- \
  bun ts/src/cli/decompose.ts --file sample.patch --classifier det --wiring llm --format ascii

echo "-- Re-render from the classified intermediate (no LLM) --"
run offline "dump the classified intermediate (det)" -- \
  bun ts/src/cli/decompose.ts --file sample.patch --classifier det --dump-classified "$tmp/sample.classified.json"
run offline "re-render a checked-in classified dump" -- \
  bun ts/src/cli/decompose.ts --from-classified samples/sample.classified.json --format ascii

echo "-- Codebase mode --"
run offline "anchor on a symbol → footprint (det)" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --classifier det \
      --anchor-file ts/src/core/contract.ts --symbol stampSeamModel --emit-seams "$tmp/footprint.json"
run offline "anchor on a whole module (det)" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --classifier det \
      --anchor-file ts/src/diff/seams.ts --emit-seams "$tmp/footprint.json"

echo "-- Structural shapes (det/offline) --"
run offline "consumers — who calls a symbol" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query consumers \
      --anchor-file ts/src/core/contract.ts --symbol stampSeamModel --format llm-context
run offline "dependencies — what a symbol uses" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query dependencies \
      --anchor-file ts/src/codebase/grow/route.ts --symbol ask --format llm-context
run offline "impact — transitive blast radius" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query impact \
      --anchor-file ts/src/core/contract.ts --symbol stampSeamModel --format llm-context
run offline "refactor — facts bundle (impact+deps+contract)" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query refactor \
      --anchor-file ts/src/core/contract.ts --symbol stampSeamModel --format llm-context
run offline "reaches — A → B + witness path" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query reaches \
      --anchor-file ts/src/codebase/grow/route.ts --symbol ask --to-symbol projectConsumerSet --format llm-context
run offline "contract — a module's boundary" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query contract --anchor-file ts/src/diff/seams.ts --format llm-context
run offline "neighborhood — the subsystem around a symbol" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query neighborhood --anchor-file ts/src/diff/seams.ts --symbol emit_seams_json
run offline "compare — two symbols by their deps" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query compare \
      --anchor-file ts/src/codebase/scan/consumers_graph.ts --symbol build_consumers_graph \
      --to-file ts/src/codebase/scan/dependency_graph.ts --to-symbol build_dependency_graph
run offline "consumers + name-grounded recall" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --query consumers --recall name \
      --anchor-file ts/src/core/contract.ts --symbol stampSeamModel --format llm-context
run model   "ask — NL question routed to a shape" -- \
  bun ts/src/cli/decompose.ts --scan --repo . --ask "who calls stampSeamModel?"

echo
echo "README audit: $ran ran, $skipped skipped$( [ "$fail" -eq 0 ] && echo ', 0 failed' || echo ', FAILURES above')."
exit "$fail"
