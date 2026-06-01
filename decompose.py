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
import sys
import webbrowser
from pathlib import Path

from src import classifier, diff_source, noise_filter, parser, renderer


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument("--file", help="path to a .patch / .diff file")
    source.add_argument("--git", metavar="REF_RANGE", help='git ref range, e.g. "main..HEAD"')
    ap.add_argument("--repo", default=".", help="repo dir for --git (default: .)")
    ap.add_argument("-o", "--out", default="report.html", help="output HTML path")
    ap.add_argument("--model", default="claude-haiku-4-5", help="model for the classify pass")
    ap.add_argument("--context-window", type=int, default=200_000,
                    help="model context window in tokens, for the fit warning (default: 200000)")
    ap.add_argument("--claude-bin", help="path to the claude CLI (else auto-detected)")
    ap.add_argument("--open", action="store_true", help="open the report in a browser")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--debug", action="store_true",
                    help="print the model's raw reply + backend diagnostics to stderr, "
                         "and dump <out>.prompt.txt / <out>.reply.txt")
    args = ap.parse_args(argv)

    try:
        diff_text = diff_source.get_diff(file=args.file, git=args.git, repo=args.repo)
    except diff_source.DiffSourceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    hunks = parser.parse(diff_text)
    if not hunks:
        print("error: no hunks found in diff", file=sys.stderr)
        return 1

    remaining = noise_filter.classify(hunks)
    noise_n = len(hunks) - len(remaining)
    if args.verbose:
        print(f"[decompose] {len(hunks)} hunks; {noise_n} pre-filtered as noise; "
              f"{len(remaining)} sent to classifier")

    try:
        classifier.classify(remaining, model=args.model, claude_bin=args.claude_bin,
                            context_window=args.context_window, verbose=args.verbose,
                            debug=args.debug, debug_path=args.out)
    except classifier.ClassifierError as exc:
        print(f"error: classification failed: {exc}", file=sys.stderr)
        return 3

    source_label = args.file if args.file else f"git {args.git}"
    out_path = renderer.render(hunks, args.out, source_label=Path(source_label).name)

    counts = {}
    for h in hunks:
        counts[h.role] = counts.get(h.role, 0) + 1
    summary = "  ".join(f"{r}={counts.get(r, 0)}" for r in ("core", "link", "environment", "noise"))
    print(f"Decomposed {len(hunks)} hunks:  {summary}")
    print(f"Report: {out_path}")

    if args.open:
        webbrowser.open(f"file://{out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
