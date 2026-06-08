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
import json
import sys
import webbrowser
from pathlib import Path

from src import classifier, classifier_det, diff_source, noise_filter, parser, renderer


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

    if args.graph:
        # CODEBASE MODE — decompose the resolver's ResolvedGraph (plan §3). Entirely
        # downstream of the SymbolResolver: the VSCode API never reaches here, only its
        # JSON contract (constraint §4). No diff, no LLM.
        from src import codebase, graph_ir
        try:
            data = json.loads(Path(args.graph).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"error: could not load resolved graph: {exc}", file=sys.stderr)
            return 2
        g = graph_ir.from_resolved_graph(data)
        if not g.nodes:
            print("error: resolved graph has no nodes", file=sys.stderr)
            return 1
        model = codebase.decompose(g)
        counts: dict[str, int] = {}
        for n in g.nodes.values():
            counts[n.role] = counts.get(n.role, 0) + 1
        summary = "  ".join(f"{r}={counts.get(r, 0)}" for r in ("core", "link", "environment", "test"))
        print(f"Decomposed anchor {g.anchor!r} ({len(g.nodes)} symbols, "
              f"resolution={g.resolution_quality or '?'}):  {summary}")
        if g.unresolved:
            print(f"  {len(g.unresolved)} unresolved (UNKNOWN, not 'no link'); "
                  f"{len(g.blindspots)} blind spot(s)")
        if args.emit_seams:
            Path(args.emit_seams).write_text(json.dumps(model), encoding="utf-8")
            print(f"Seams: {args.emit_seams}")
        return 0

    if args.from_classified:
        # Reuse a previous classify pass — no diff parsing, no LLM. Lets the
        # renderer/template be iterated on against a fixed, real example.
        try:
            hunks = parser.hunks_from_json(Path(args.from_classified).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"error: could not load classified hunks: {exc}", file=sys.stderr)
            return 2
        if not hunks:
            print("error: no hunks in classified file", file=sys.stderr)
            return 1
        # Back-compat: dumps written before `placements` existed carry none. They're a pure
        # function of the diff text + flat roles, so reconstruct them (deterministic, no LLM)
        # rather than silently dropping the overlap on re-render.
        if not any(h.placements for h in hunks):
            classifier_det.assign_spans([h for h in hunks if h.role != "noise"], repo=args.repo)
        if args.verbose:
            print(f"[decompose] loaded {len(hunks)} pre-classified hunks; skipping classifier")
        source_label = args.from_classified
    else:
        try:
            diff_text = diff_source.get_diff(file=args.file, git=args.git, repo=args.repo)
        except diff_source.DiffSourceError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

        hunks = parser.parse(diff_text)
        if not hunks:
            print("error: no hunks found in diff", file=sys.stderr)
            return 1

        if args.emit_hunks:
            # Skeleton for an external facts producer: Python owns hunk-id assignment, so
            # the extension keys its facts to the SAME ids. Parse only — no LLM, no render.
            from src import facts as facts_mod
            skel = []
            for h in hunks:
                cn = facts_mod.changed_newside(h)
                start, end = (cn[0], max(cn[0], cn[1] - 1)) if cn else (0, 0)
                skel.append({"id": h.id, "file": h.file_path, "start": start, "end": end})
            Path(args.emit_hunks).write_text(
                json.dumps({"version": facts_mod.FACTS_SCHEMA_VERSION, "hunks": skel}),
                encoding="utf-8")
            print(f"Hunks: {args.emit_hunks}")
            return 0

        remaining = noise_filter.classify(hunks)
        noise_n = len(hunks) - len(remaining)
        if args.verbose:
            print(f"[decompose] {len(hunks)} hunks; {noise_n} pre-filtered as noise; "
                  f"{len(remaining)} sent to classifier")

        # Resolve per-pass engines: a per-pass flag wins; else the --classifier preset;
        # else the hybrid default (cluster=llm, roles=det, wiring=det).
        from src import engine as engine_mod, facts as facts_mod
        cluster = args.cluster or args.classifier or engine_mod.DEFAULTS["cluster"]
        roles = args.roles or args.classifier or engine_mod.DEFAULTS["roles"]
        wiring = args.wiring or args.classifier or engine_mod.DEFAULTS["wiring"]

        # A facts provider feeds the DETERMINISTIC passes (roles/wiring/cluster) only.
        facts_provider = None
        if "det" in (cluster, roles, wiring):
            if args.facts:
                payload = json.loads(Path(args.facts).read_text(encoding="utf-8"))
                if payload.get("partial"):
                    # External source filled only some fields (VS Code DocumentSymbols →
                    # defines/enclosing); the rest from a base — tree-sitter if available.
                    base = facts_mod.RegexFactsProvider()
                    from src import facts_treesitter as ts
                    if ts.available():
                        base = ts.TreeSitterFactsProvider(facts_mod.RepoFileSource(args.repo))
                    facts_provider = facts_mod.MergedFactsProvider(base, payload)
                    if args.verbose:
                        print(f"[decompose] merged facts from {args.facts} "
                              f"(fields={payload.get('fields')}; base="
                              f"{'treesitter' if ts.available() else 'regex'})")
                else:
                    facts_provider = facts_mod.ExternalFactsProvider(payload)
                    if args.verbose:
                        print(f"[decompose] external facts from {args.facts} "
                              f"({len(payload.get('hunks', {}))} hunks; regex fallback for the rest)")
            elif args.facts_engine == "treesitter":
                from src import facts_treesitter as ts
                if not ts.available():
                    print("warning: tree-sitter not installed; falling back to regex facts "
                          "(pip install tree_sitter tree-sitter-language-pack)", file=sys.stderr)
                else:
                    facts_provider = ts.TreeSitterFactsProvider(facts_mod.RepoFileSource(args.repo))
                    if args.verbose:
                        print(f"[decompose] tree-sitter facts (full file, repo={args.repo}); "
                              f"regex fallback per unavailable/misaligned hunk")

        try:
            engine_mod.classify(remaining, cluster=cluster, roles=roles, wiring=wiring,
                                facts_provider=facts_provider, model=args.model,
                                claude_bin=args.claude_bin, context_window=args.context_window,
                                verbose=args.verbose, debug=args.debug, debug_path=args.out,
                                repo=args.repo)
        except classifier.ClassifierError as exc:
            print(f"error: classification failed: {exc}", file=sys.stderr)
            return 3

        if args.dump_classified:
            Path(args.dump_classified).write_text(parser.hunks_to_json(hunks), encoding="utf-8")
            if args.verbose:
                print(f"[decompose] wrote classified hunks -> {args.dump_classified}")

        source_label = args.file if args.file else f"git {args.git}"

    counts = {}
    for h in hunks:
        counts[h.role] = counts.get(h.role, 0) + 1
    summary = "  ".join(f"{r}={counts.get(r, 0)}" for r in ("core", "link", "environment", "test", "noise"))
    print(f"Decomposed {len(hunks)} hunks:  {summary}")

    if args.emit_seams:
        # Native-rendering surface (VS Code extension): structured seam data, no HTML.
        # repo lets the renderer resolve local aliases against the actual files.
        Path(args.emit_seams).write_text(json.dumps(renderer.emit_seams_json(hunks, repo=args.repo)),
                                         encoding="utf-8")
        print(f"Seams: {args.emit_seams}")
        return 0

    out_path = renderer.render(hunks, args.out, source_label=Path(source_label).name, repo=args.repo)
    print(f"Report: {out_path}")

    if args.open:
        webbrowser.open(f"file://{out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
