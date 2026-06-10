"""Codebase-mode entry — the strategy `run` that decomposes an anchor footprint into seams.
Extracted verbatim from the old decompose.py codebase branch (CLI flags unchanged)."""
from __future__ import annotations

import json
import sys
from pathlib import Path


class CodebaseMode:
    name = "codebase"

    def claims(self, args) -> bool:
        return bool(args.graph or args.scan or args.expand_graph)

    def run(self, args) -> int:
        if getattr(args, "resolver", "det") != "det":    # install the resolution strategy (det is the default floor)
            from src.codebase import import_scan, resolver
            import_scan.set_resolver(resolver.make_resolver(args.resolver))
        # CODEBASE MODE — decompose a ResolvedGraph (plan §3). Entirely downstream of the FRONT:
        # the VSCode API never reaches here, only the JSON contract (constraint §4). No diff, no LLM.
        # Fronts producing the same contract: --graph (LSP resolver JSON), --scan (import-scan front),
        # --expand-graph (P2: grow an existing graph by merging another scan into it).
        from src.codebase import codebase
        from src.core import graph_ir
        if args.expand_graph:
            if not (args.expand_file and args.expand_symbol):
                print("error: --expand-graph requires --expand-file and --expand-symbol", file=sys.stderr)
                return 2
            from src.codebase import expand, import_scan
            try:
                base = json.loads(Path(args.expand_graph).read_text(encoding="utf-8"))
                # The expanded node becomes a core either way. UP (default) = consumers (importers +
                # call-sites). DOWN = dependencies, added as WIRING (links adjacent to the now-core
                # source) — deps don't become cores, so the core set stays the focus (no flattening).
                add = (import_scan.build_dependency_graph(args.repo, args.expand_file, args.expand_symbol, anchor_line=args.expand_line)
                       if args.down
                       else import_scan.build_consumers_graph(args.repo, args.expand_file, args.expand_symbol, depth=args.depth, anchor_line=args.expand_line))
                data = expand.merge_resolved(base, add, expand_anchor=add.get("anchor", {}).get("id"))
                if args.cross_from:    # P4: this expansion crossed a boundary by assumption — record it
                    data.setdefault("blindspots", []).append(
                        {"node": add.get("anchor", {}).get("symbol", ""), "mechanism": "suggested-crossing",
                         "evidence": args.cross_from, "candidates": []})
            except Exception as exc:  # noqa: BLE001
                print(f"error: expand failed: {exc}", file=sys.stderr)
                return 2
        elif args.scan:
            if not args.anchor_file:
                print("error: --scan requires --anchor-file", file=sys.stderr)
                return 2
            from src.codebase import import_scan
            # CLASS anchor, phase 1: emit the LSP-verification candidates and exit (the extension
            # verifies them, then re-invokes with --attribution).
            if args.emit_candidates:
                if not args.symbol:
                    print("error: --emit-candidates needs --symbol (a class anchor)", file=sys.stderr)
                    return 2
                cands = import_scan.class_call_candidates(args.repo, args.anchor_file, args.symbol)
                Path(args.emit_candidates).write_text(json.dumps(cands), encoding="utf-8")
                print(f"Candidates: {args.emit_candidates}  ({len(cands)} call-site(s))")
                return 0
            if args.auto:
                # P5: LLM-directional auto-orchestration — grow toward the intent, then decompose.
                if not (args.symbol and args.intent):
                    print("error: --auto requires --symbol and --intent", file=sys.stderr)
                    return 2
                from src.codebase import orchestrate
                try:
                    data, hist = orchestrate.auto_orchestrate(args.repo, args.anchor_file, args.symbol,
                                                              args.intent, max_steps=args.max_steps,
                                                              model=args.model, claude_bin=args.claude_bin)
                except Exception as exc:  # noqa: BLE001
                    print(f"error: auto-orchestration failed: {exc}", file=sys.stderr)
                    return 2
                print(f"[auto] {len(hist)} move(s): " + (", ".join(f"{h['direction']}:{h['node']}(+{h['added']})" for h in hist) or "none"))
                g = graph_ir.from_resolved_graph(data)
                model = codebase.decompose(g, repo=args.repo, use_llm=True, intent=args.intent,
                                           model=args.model, claude_bin=args.claude_bin)
                model["autoGrown"] = True   # the GROWN footprint is the answer — render it ALL, don't isolate one seam
                if args.emit_graph:
                    Path(args.emit_graph).write_text(json.dumps(data), encoding="utf-8")
                if args.emit_seams:
                    Path(args.emit_seams).write_text(json.dumps(model), encoding="utf-8")
                    print(f"Seams: {args.emit_seams}")
                return 0
            verified = None
            if args.attribution:
                try:
                    verified = json.loads(Path(args.attribution).read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    print(f"error: could not load attribution: {exc}", file=sys.stderr)
                    return 2
            try:
                # --symbol → single-symbol anchor; CONSUMERS = importers + (class/interface) call-sites
                # in one (a class still delegates to method mode internally, using `verified`). Omit
                # --symbol → MODULE mode (all exports as members, member co-occurrence — §11.1).
                data = (import_scan.build_consumers_graph(args.repo, args.anchor_file, args.symbol,
                                                          depth=args.depth, verified=verified)
                        if args.symbol
                        else import_scan.build_module_graph(args.repo, args.anchor_file))
            except Exception as exc:  # noqa: BLE001 — surface any scan failure as a clean error
                print(f"error: import scan failed: {exc}", file=sys.stderr)
                return 2
        else:
            try:
                data = json.loads(Path(args.graph).read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                print(f"error: could not load resolved graph: {exc}", file=sys.stderr)
                return 2
        g = graph_ir.from_resolved_graph(data)
        if not g.nodes:
            print("error: resolved graph has no nodes", file=sys.stderr)
            return 1
        # --repo enables the Layer-2 scan for statically-opaque couplings (dynamic imports
        # that load the anchor by string path — invisible to the reference resolver).
        # --classifier llm|hybrid lets the LLM refine the intent partition (a PROPOSED partition,
        # seeded by the deterministic floor); det = floor only.
        use_llm = args.classifier in ("llm", "hybrid")
        model = codebase.decompose(g, repo=args.repo, use_llm=use_llm, intent=args.intent,
                                   model=args.model, claude_bin=args.claude_bin)
        if args.expand_graph:
            # An expansion GROWS the footprint (you dug into a node to see what it reaches) — show the
            # whole grown graph, don't re-run the intent selection and isolate to one seam (which jumps
            # away from both your focus and the very nodes you just expanded into).
            model["autoGrown"] = True
        counts: dict[str, int] = {}
        for n in g.nodes.values():
            counts[n.role] = counts.get(n.role, 0) + 1
        summary = "  ".join(f"{r}={counts.get(r, 0)}" for r in ("core", "link", "environment", "test"))
        print(f"Decomposed anchor {g.anchor!r} ({len(g.nodes)} symbols, "
              f"resolution={g.resolution_quality or '?'}):  {summary}")
        if g.unresolved:
            print(f"  {len(g.unresolved)} unresolved (UNKNOWN, not 'no link'); "
                  f"{len(g.blindspots)} blind spot(s)")
        if args.emit_graph:        # the session ResolvedGraph (scanned/merged) — the extension keeps it to EXPAND
            Path(args.emit_graph).write_text(json.dumps(data), encoding="utf-8")
        if args.emit_seams:
            Path(args.emit_seams).write_text(json.dumps(model), encoding="utf-8")
            print(f"Seams: {args.emit_seams}")
        return 0


MODE = CodebaseMode()
