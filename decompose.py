#!/usr/bin/env python3
"""Read-time change decomposition — MVP CLI.

Takes a real diff and presents it decomposed into core / link / environment /
noise so a human can review by intent instead of scrolling file-by-file.

It structures; it never judges. The human trusts.

Usage:
    python decompose.py --file change.patch [--open]
    python decompose.py --git main..HEAD --repo /path/to/repo [--open]
"""

from __future__ import annotations

import argparse

from src.codebase.run import MODE as CODEBASE_MODE
from src.core.mode import dispatch
from src.diff.run import MODE as DIFF_MODE

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument("--file", help="path to a .patch / .diff file")
    source.add_argument("--git", metavar="REF_RANGE", help='git ref range, e.g. "main..HEAD"')
    source.add_argument("--from-classified", metavar="JSON",
                        help="render straight from a dumped classified-hunks JSON "
                             "(the post-classify intermediate state) — skips the LLM pass")
    source.add_argument("--graph", metavar="JSON",
                        help="CODEBASE MODE: decompose a ResolvedGraph JSON (the SymbolResolver "
                             "front's output — anchor + resolved nodes/edges) instead of a diff. "
                             "Use with --emit-seams. No LLM, no diff parsing.")
    source.add_argument("--scan", action="store_true",
                        help="CODEBASE MODE (import-scan discovery): build the ResolvedGraph by a "
                             "deterministic named-import scan instead of LSP find-references "
                             "(monorepo-safe, offline). Requires --repo, --anchor-file, --symbol.")
    ap.add_argument("--anchor-file", help="--scan: repo-relative path of the anchor symbol's defining file")
    ap.add_argument("--symbol", help="--scan: the anchor symbol name")
    ap.add_argument("--depth", type=int, default=1,
                    help="--scan single-symbol: 1 = direct consumers; 2 = + environment ripple "
                         "(consumers-of-consumers = the boundary frontier)")
    ap.add_argument("--emit-candidates", metavar="JSON",
                    help="--scan CLASS anchor: write the method call-site candidates (file/line/col/"
                         "method) for the extension's LSP go-to-definition verification, then exit")
    ap.add_argument("--attribution", metavar="JSON",
                    help="--scan CLASS anchor: an LSP-verified {file: {method: line}} attribution to "
                         "use (RESOLVED_FULL) instead of the tree-sitter heuristic (RESOLVED_PARTIAL)")
    ap.add_argument("--intent", metavar="TEXT",
                    help="CODEBASE mode (P1): the user's question; the LLM refine pass marks the "
                         "best-matching seam (`selectedSeam`) so the renderer focuses it. Needs an LLM.")
    ap.add_argument("--auto", action="store_true",
                    help="--scan (P5): LLM-directional AUTO-orchestration — grow the footprint toward "
                         "--intent (the LLM picks node + up/down each step). Needs --symbol + --intent + LLM.")
    ap.add_argument("--max-steps", type=int, default=4, help="--auto: max expansion steps (default 4)")
    ap.add_argument("--emit-graph", metavar="JSON",
                    help="CODEBASE mode: also write the (scanned/merged) ResolvedGraph here so the "
                         "extension can keep it as the session graph and EXPAND it (P2).")
    source.add_argument("--expand-graph", metavar="JSON",
                        help="CODEBASE mode (P2 expand): a base ResolvedGraph to GROW — scan --expand-file/"
                             "--expand-symbol and MERGE it in (the picked node becomes a sub-anchor).")
    ap.add_argument("--expand-file", help="--expand-graph: repo-relative file of the node to expand from")
    ap.add_argument("--expand-symbol", help="--expand-graph: symbol name of the node to expand from")
    ap.add_argument("--expand-line", type=int,
                    help="--expand-graph: the node's start line, so the merge dedups it to the "
                         "existing node (esp. for label-less / module-level nodes)")
    ap.add_argument("--down", action="store_true",
                    help="--expand-graph: expand DOWNWARD to the node's dependencies (what it uses: "
                         "service→repository→prisma) instead of upward to its consumers (P3).")
    ap.add_argument("--cross-from", metavar="TEXT",
                    help="--expand-graph: this expansion CROSSED a boundary via symbol-match (P4) — "
                         "record it as a SUGGESTED-crossing blind spot (an assumption, not resolved).")
    ap.add_argument("--repo", default=".", help="repo dir for --git (default: .)")
    ap.add_argument("-o", "--out", default="report.html", help="output HTML path")
    ap.add_argument("--dump-classified", metavar="JSON",
                    help="after classifying, also write the labeled hunks to JSON so the "
                         "report can later be regenerated with --from-classified (no LLM)")
    # Per-pass engine levers — each is llm | det | hybrid (deterministic + LLM reconcile on
    # the residual). DEFAULT: cluster=llm (only reliable grouping), roles=det (beats LLM),
    # wiring=hybrid (det + LLM prune of over-wired container hunks; no-op/free on focused diffs).
    ap.add_argument("--cluster", choices=("llm", "det", "hybrid"),
                    help="CLUSTER engine (product-intent grouping): llm | det | hybrid "
                         "(det grouping + LLM labels). Default: llm")
    ap.add_argument("--roles", choices=("llm", "det", "hybrid"),
                    help="ROLES engine: llm | det | hybrid (det + LLM re-judges uncertain). Default: det")
    ap.add_argument("--wiring", choices=("llm", "det", "hybrid"),
                    help="WIRING engine: llm | det | hybrid (det + reconcile + LLM prune). Default: hybrid")
    ap.add_argument("--classifier", choices=("llm", "det", "hybrid"),
                    help="preset that sets ALL THREE passes to one engine (a per-pass flag "
                         "overrides it). Omit for the default (cluster=llm, roles=det, wiring=hybrid); "
                         "use 'det' for fully offline (no LLM)")
    ap.add_argument("--resolver", choices=("det", "lsp", "auto"), default="det",
                    help="how to resolve imports (codebase mode): 'det' = deterministic floor "
                         "(relative+package+tsconfig paths, offline); 'lsp' = a real language server "
                         "(go-to-definition, cross-language, needs the toolchain); 'auto' = LSP with "
                         "deterministic fallback. See resolver-lsp-plan.md.")
    ap.add_argument("--facts", metavar="JSON",
                    help="external HunkFacts payload (e.g. AST facts the VS Code extension "
                         "computed) to drive the 'det' classifier; missing hunks fall back to regex")
    ap.add_argument("--facts-engine", choices=("regex", "treesitter"), default="regex",
                    help="syntax source for the 'det' classifier: 'regex' (default, fragment-based) "
                         "or 'treesitter' (full-file AST via the working tree; falls back to regex "
                         "per hunk when a file is unavailable/misaligned). Ignored if --facts is set")
    ap.add_argument("--emit-hunks", metavar="JSON",
                    help="parse only: emit the hunk skeleton (id, file, new-side start/end) so an "
                         "external producer (the VS Code extension) can compute facts keyed by the "
                         "SAME hunk ids; skips classification and rendering")
    ap.add_argument("--model", default="claude-haiku-4-5", help="model for the classify pass")
    ap.add_argument("--context-window", type=int, default=200_000,
                    help="model context window in tokens, for the fit warning (default: 200000)")
    ap.add_argument("--claude-bin", help="path to the claude CLI (else auto-detected)")
    ap.add_argument("--open", action="store_true", help="open the report in a browser")
    ap.add_argument("--emit-seams", metavar="JSON",
                    help="write structured seam data (file + line range + role per hunk) "
                         "to this path for the VS Code extension; skips HTML rendering")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--debug", action="store_true",
                    help="print the model's raw reply + backend diagnostics to stderr, "
                         "and dump <out>.prompt.txt / <out>.reply.txt")
    args = ap.parse_args(argv)

    # Route to the mode that claims these args (codebase: --graph/--scan/--expand-graph;
    # diff: the --file/--git/--from-classified fallback). Pipelines live in src/{diff,codebase}/run.py.
    return dispatch([CODEBASE_MODE, DIFF_MODE], args)


if __name__ == "__main__":
    raise SystemExit(main())
