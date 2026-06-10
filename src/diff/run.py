"""Diff-mode entry — the strategy `run` that decomposes a working-tree diff into seams/HTML.
Extracted verbatim from the old decompose.py diff branch (CLI flags unchanged)."""
from __future__ import annotations

import json
import sys
import webbrowser
from pathlib import Path

from src.diff import classifier, classifier_det, diff_source, noise_filter, parser, seams
from src.diff.report_html import render as render_html


class DiffMode:
    name = "diff"

    def claims(self, args) -> bool:
        return True   # the fallback: --file / --git / --from-classified

    def run(self, args) -> int:
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
                from src.diff import facts as facts_mod
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
            from src.diff import engine as engine_mod, facts as facts_mod
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
                        from src.diff import facts_treesitter as ts
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
                    from src.diff import facts_treesitter as ts
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
            Path(args.emit_seams).write_text(json.dumps(seams.emit_seams_json(hunks, repo=args.repo)),
                                             encoding="utf-8")
            print(f"Seams: {args.emit_seams}")
            return 0

        out_path = render_html(hunks, args.out, source_label=Path(source_label).name, repo=args.repo)
        print(f"Report: {out_path}")

        if args.open:
            webbrowser.open(f"file://{out_path}")
        return 0


MODE = DiffMode()
