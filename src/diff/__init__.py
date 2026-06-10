"""Diff-mode pipeline — review WORKING CHANGES (a git diff) decomposed into intent seams.

Self-contained: imports only from `..core` (shared engine) and within `diff/`. The flow is
parser → facts (regex/tree-sitter) → classifier(_det) → seams (assembly) → report_html. See
`core.mode.DiffMode` for the strategy entry point."""
