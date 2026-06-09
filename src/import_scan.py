"""Import-scan consumer discovery — the DETERMINISTIC front that replaces LSP find-references
for module-level symbols (Phase-0 verdict: `executeReferenceProvider` is project-scoped and
blind to cross-project consumers in a monorepo; a named-import scan recovers them — memory:
lsp-references-monorepo-blind, calibration §11).

This is a second producer of the SAME `ResolvedGraph` contract the VSCode resolver emits, so
`graph_ir.from_resolved_graph` ingests it unchanged and the whole codebase pipeline
(`codebase.decompose`) runs on it — OFFLINE, no LSP, no F5 (D1/D6: a swappable FRONT).

THE INVARIANT (plan §1) lives here too: an edge is stamped RESOLVED only when the import's
module path RESOLVES to the anchor file (package-name map / relative path). A name match whose
module does NOT resolve is recorded as a SUGGESTED blindspot — never a resolved edge. So the
completeness promise is never over-claimed, and `assert_resolved_only` stays valid downstream.

Recall mechanism = named imports (cross-project, cheap). Precision mechanism = module-path
resolution + per-site enclosing-symbol resolution via tree-sitter (`atoms._Ctx`). Scope: this
finds MODULE-EXPORT-level consumers (the §11 case). Class-METHOD consumers (`import the class,
call .method()`) and the depth-2 hop are refinements noted for later.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

from .atoms import _CALL, _FUNCLIKE, _Ctx, available, lang_for
from .lang import _IMPORT_RE

_SKIP_DIRS = {"node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv", "out"}
_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts")
_RESOLVE_EXTS = (".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts")

# tree-sitter declaration kinds that carry a name → an enclosing symbol (a consumer unit).
_METHOD_KINDS = {"method_definition", "method_declaration", "constructor_declaration"}
_CLASS_KINDS = {"class_declaration", "class_definition", "class_specifier", "struct_specifier"}
_NAME_KINDS = {"identifier", "property_identifier", "type_identifier"}


# --------------------------------------------------------------------------- module resolution
def _pkg_map(repo: str) -> dict[str, str]:
    """{package name → package dir (repo-relative)} from every package.json — the monorepo's
    cross-project link map (e.g. `@calcom/lib` → `packages/lib`). This is what makes a
    cross-project import deterministically RESOLVABLE without a language server."""
    out: dict[str, str] = {}
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        if "package.json" in files:
            try:
                data = json.load(open(os.path.join(root, "package.json"), encoding="utf-8"))
            except (OSError, ValueError):
                continue
            name = data.get("name")
            if name:
                out.setdefault(name, os.path.relpath(root, repo))
    return out


def _resolve_file(repo: str, base_rel: str) -> str | None:
    """A bare module path (no extension) → an actual repo-relative file, probing the usual
    extensions and `/index`. Returns None if nothing exists (→ unresolved → SUGGESTED)."""
    cand = os.path.normpath(os.path.join(repo, base_rel))
    for ext in _RESOLVE_EXTS:
        if os.path.isfile(cand + ext):
            return os.path.relpath(cand + ext, repo)
    if os.path.isfile(cand):
        return os.path.relpath(cand, repo)
    for ext in _RESOLVE_EXTS:
        idx = os.path.join(cand, "index" + ext)
        if os.path.isfile(idx):
            return os.path.relpath(idx, repo)
    return None


def resolve_module(repo: str, importing_file: str, source: str, pkgs: dict[str, str]) -> str | None:
    """Resolve an import `source` (as written in `importing_file`) to a repo-relative file, or
    None. Handles relative (`./`, `../`) and monorepo package names (`@scope/pkg/sub`). tsconfig
    path aliases (`~/…`) are NOT resolved here (best-effort gap → caller treats as SUGGESTED)."""
    if source.startswith("."):
        base = os.path.join(os.path.dirname(importing_file), source)
        return _resolve_file(repo, base)
    # longest matching package name (so `@calcom/lib` wins over `@calcom`)
    for name in sorted(pkgs, key=len, reverse=True):
        if source == name or source.startswith(name + "/"):
            sub = source[len(name):].lstrip("/")
            return _resolve_file(repo, os.path.join(pkgs[name], sub) if sub else pkgs[name])
    return None


# --------------------------------------------------------------------------- named-import scan
def _local_name(named_part: str) -> tuple[str, str] | None:
    p = named_part.strip()
    if not p:
        return None
    if " as " in p:
        a, b = p.split(" as ", 1)
        return a.strip(), b.strip()
    return p, p


@dataclass
class Consumer:
    file: str                  # repo-relative
    local: str                 # local binding name (after `as`)
    source: str                # import source as written
    status: str                # "resolved" (module → anchor file) | "suggested" (basename only)


def scan_consumers(repo: str, anchor_file: str, symbol: str) -> list[Consumer]:
    """Files importing `symbol`, classified by how confidently the module is the anchor's:

      - "resolved"  — the import path resolves to `anchor_file` (RESOLVED edge).
      - "suggested" — the path is UNRESOLVABLE (alias we can't follow) but shares the anchor's
                      basename ⇒ might be ours, can't confirm (SUGGESTED blind spot).

    A path that resolves to a DIFFERENT file is a same-named OTHER symbol → EXCLUDED (a confirmed
    true-negative, not a blind spot). A non-matching unresolvable path → excluded. Recall by
    named imports; honesty by the resolved/suggested split."""
    anchor_norm = os.path.normpath(anchor_file)
    anchor_base = os.path.splitext(os.path.basename(anchor_file))[0]
    pkgs = _pkg_map(repo)
    anchor_abs = os.path.normpath(os.path.join(repo, anchor_file))
    out: list[Consumer] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_EXTS):
                continue
            path = os.path.join(root, fn)
            if os.path.normpath(path) == anchor_abs:
                continue
            try:
                text = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if symbol not in text:
                continue
            rel = os.path.relpath(path, repo)
            for m in _IMPORT_RE.finditer(text):
                named, source = m.group(2), m.group(3)
                if not named:
                    continue
                hit = next((ln for part in named.split(",")
                            if (ln := _local_name(part)) and ln[0] == symbol), None)
                if not hit:
                    continue
                resolved_to = resolve_module(repo, rel, source, pkgs)
                if resolved_to is not None:
                    if os.path.normpath(resolved_to) == anchor_norm:
                        out.append(Consumer(rel, hit[1], source, "resolved"))
                    # else: resolved to a DIFFERENT file → a same-named other symbol → exclude
                elif source.rstrip("/").split("/")[-1] == anchor_base:
                    out.append(Consumer(rel, hit[1], source, "suggested"))   # unresolvable + basename
                break
    return out


# --------------------------------------------------------------------------- tree-sitter symbols
def _name_of(ctx: _Ctx, node) -> str | None:
    for c in ctx.children(node):
        if c.kind() in _NAME_KINDS:
            return ctx.text(c)
    return None


def _named_units(ctx: _Ctx) -> list[tuple[str, str, int, int]]:
    """All named code units in the file as (name, kind, start, end) — function/method/class
    declarations AND `const x = () => …` arrows (anonymous funclike bound to a name)."""
    units: list[tuple[str, str, int, int]] = []

    def visit(n) -> None:
        k = n.kind()
        if k in _FUNCLIKE and k not in ("arrow_function", "function_expression"):
            nm = _name_of(ctx, n)
            if nm:
                s, e = ctx.span(n)
                units.append((nm, "method" if k in _METHOD_KINDS else "function", s, e))
        elif k in _CLASS_KINDS:
            nm = _name_of(ctx, n)
            if nm:
                s, e = ctx.span(n)
                units.append((nm, "class", s, e))
        elif k == "variable_declarator":
            ch = ctx.children(n)
            fl = next((c for c in ch if c.kind() in _FUNCLIKE), None)
            if fl is not None and ch and ch[0].kind() in _NAME_KINDS:
                s, e = ctx.span(fl)
                units.append((ctx.text(ch[0]), "function", s, e))
        for c in ctx.children(n):
            visit(c)

    visit(ctx.root)
    return units


def _enclosing(units: list[tuple[str, str, int, int]], line: int) -> tuple[str, str, int, int] | None:
    """Innermost named unit containing `line` (smallest span). None ⇒ module top-level use."""
    cands = [u for u in units if u[2] <= line <= u[3]]
    return min(cands, key=lambda u: u[3] - u[2]) if cands else None


def _call_lines(ctx: _Ctx, local: str) -> list[int]:
    """0-based lines where `local(` is invoked (callee identifier == local)."""
    lines: list[int] = []
    for c in ctx.collect(ctx.root, lambda k: k in _CALL):
        ch = ctx.children(c)
        if ch and "identifier" in ch[0].kind() and ctx.text(ch[0]) == local:
            lines.append(ctx.span(c)[0])
    return lines


def _read(repo: str, rel: str) -> tuple[str, str] | None:
    lang = lang_for(rel)
    if not lang:
        return None
    try:
        return open(os.path.join(repo, rel), encoding="utf-8", errors="ignore").read(), lang
    except OSError:
        return None


# --------------------------------------------------------------------------- depth-2 ripple
def _depth2_ripple(repo: str, consumers: list[dict], pkgs: dict[str, str],
                   counter: int, seen_keys: dict[str, str]) -> tuple[list[dict], list[dict], int]:
    """The ENVIRONMENT RIPPLE (plan: depth-2 = the boundary frontier). For each depth-1 consumer
    that is itself an EXPORTED symbol, find ITS importers (consumers-of-consumers) and wire them in.
    They become `environment` by role (adjacent to a link, not the core) = the frontier where the
    footprint hands off to other intents. Honest gap: a NON-exported consumer (an internal/anon
    function) has no import-scan-discoverable ripple — it's a leaf of this view."""
    targets: dict[tuple[str, str], str] = {}        # (exported symbol, norm file) → consumer node id
    for n in consumers:
        if n["kind"] == "module":                   # a module-level use, not a named export
            continue
        rd = _read(repo, n["file"])
        if not rd:
            continue
        try:
            if n["symbol"] in {m[0] for m in _exported_members(_Ctx(rd[0], rd[1]))}:
                targets[(n["symbol"], os.path.normpath(n["file"]))] = n["id"]
        except Exception:
            continue
    if not targets:
        return [], [], counter
    target_syms = {s for s, _ in targets}
    new_nodes: list[dict] = []
    new_edges: list[dict] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_EXTS):
                continue
            path = os.path.join(root, fn)
            try:
                text = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if not any(s in text for s in target_syms):
                continue
            rel = os.path.relpath(path, repo)
            hits: dict[str, str] = {}                # target consumer node id → local binding
            for m in _IMPORT_RE.finditer(text):
                named, source = m.group(2), m.group(3)
                if not named:
                    continue
                resolved_to = resolve_module(repo, rel, source, pkgs)
                if resolved_to is None:
                    continue
                rnorm = os.path.normpath(resolved_to)
                for part in named.split(","):
                    ln = _local_name(part)
                    if ln and (tid := targets.get((ln[0], rnorm))):
                        hits[tid] = ln[1]
            if not hits:
                continue
            rd = _read(repo, rel)
            if not rd:
                continue
            try:
                cctx = _Ctx(rd[0], rd[1])
            except Exception:
                continue
            units = _named_units(cctx)
            for tid, local in hits.items():
                line = next(iter(_call_lines(cctx, local)), 0)
                enc = _enclosing(units, line)
                if enc:
                    name, kind, start, end = enc
                else:
                    name, kind, start, end = os.path.splitext(os.path.basename(rel))[0], "module", line, line
                key = f"{rel}#{name}#{start}"
                d2id = seen_keys.get(key)
                if d2id is None:
                    counter += 1
                    d2id = f"n{counter}"
                    seen_keys[key] = d2id
                    new_nodes.append({"id": d2id, "symbol": name, "kind": kind, "file": rel,
                                      "range": [start, end], "enclosing": "", "complexity": max(1, end - start + 1)})
                if d2id != tid:
                    new_edges.append({"from": d2id, "to": tid, "kind": "reference", "provenance": "RESOLVED_FULL"})
    return new_nodes, new_edges, counter


# --------------------------------------------------------------------------- ResolvedGraph build
def build_resolved_graph(repo: str, anchor_file: str, symbol: str, *, depth: int = 1) -> dict:
    """Assemble the `ResolvedGraph` JSON (resolver.ts contract) from a deterministic import scan.
    Anchor = the symbol's definition; nodes = the enclosing symbol at each resolved consumer's
    call-site; resolved edges = consumer → anchor. Unresolved-module name matches become
    SUGGESTED blindspots (honest under-claim), never resolved edges."""
    repo = os.path.expanduser(repo)
    nodes: list[dict] = []
    edges: list[dict] = []
    blindspots: list[dict] = []
    unresolved: list[dict] = []

    # ---- anchor node (its definition range, via tree-sitter) ----
    arange = [0, 0]
    akind = "symbol"
    ar = _read(repo, anchor_file)
    if ar and available():
        try:
            ctx = _Ctx(ar[0], ar[1])
            defu = next((u for u in _named_units(ctx) if u[0] == symbol), None)
            if defu:
                akind, arange = defu[1], [defu[2], defu[3]]
        except Exception:
            pass
    nodes.append({"id": "n1", "symbol": symbol, "kind": akind, "file": anchor_file,
                  "range": arange, "enclosing": "", "complexity": max(1, arange[1] - arange[0] + 1)})

    # ---- consumers ----
    counter = 1
    seen_keys: dict[str, str] = {}
    for con in scan_consumers(repo, anchor_file, symbol):
        if con.status == "suggested":
            blindspots.append({"node": "n1", "mechanism": "unresolved-import",
                               "evidence": f"{con.file} imports {symbol} from '{con.source}' (module unresolved)",
                               "candidates": [{"symbol": con.file}]})
            unresolved.append({"node": "n1", "query": "resolveModule", "reason": f"unresolved:{con.source}"})
            continue
        rd = _read(repo, con.file)
        if not rd:
            continue
        try:
            cctx = _Ctx(rd[0], rd[1])
        except Exception:
            continue
        units = _named_units(cctx)
        lines = _call_lines(cctx, con.local) or [0]
        for ln in lines:
            enc = _enclosing(units, ln)
            if enc:
                name, kind, start, end = enc
                cls = next((u[0] for u in units if u[1] == "class" and u[2] <= start and end <= u[3]), "")
            else:                                        # module top-level use → the file is the consumer
                name = os.path.splitext(os.path.basename(con.file))[0]
                kind, start, end, cls = "module", ln, ln, ""
            key = f"{con.file}#{name}#{start}"
            if key in seen_keys:
                continue
            counter += 1
            cid = f"n{counter}"
            seen_keys[key] = cid
            nodes.append({"id": cid, "symbol": name, "kind": kind, "file": con.file,
                          "range": [start, end], "enclosing": cls,
                          "complexity": max(1, end - start + 1)})
            edges.append({"from": cid, "to": "n1", "kind": "reference", "provenance": "RESOLVED_FULL"})

    # depth-2 ripple (the boundary frontier): consumers-of-consumers, auto-roled environment.
    if depth >= 2 and available():
        d2_nodes, d2_edges, counter = _depth2_ripple(repo, nodes[1:], _pkg_map(repo), counter, seen_keys)
        nodes.extend(d2_nodes)
        edges.extend(d2_edges)

    return {
        "version": 1,
        "anchor": {"id": "n1", "symbol": symbol, "file": anchor_file, "range": arange},
        "language": (lang_for(anchor_file) or ""),
        "resolutionQuality": "FULL",       # deterministic scan, complete over named imports
        "depth": depth,
        "complete": True,
        "nodes": nodes,
        "edges": edges,
        "blindspots": blindspots,
        "unresolved": unresolved,
    }


# --------------------------------------------------------------------------- MULTI-MEMBER (module)
def _exported_members(ctx: _Ctx) -> list[tuple[str, str, int, int]]:
    """A module's EXPORTED top-level members as (name, kind, start, end) — its carriers. Reads
    `export function/class X` and `export const/let X = …` (kind 'function' if the value is funclike,
    else 'constant'). Re-exports / `export default` are best-effort skipped."""
    out: list[tuple[str, str, int, int]] = []
    for es in ctx.collect(ctx.root, lambda k: k == "export_statement"):
        for ch in ctx.children(es):
            k = ch.kind()
            if k in _FUNCLIKE and k not in ("arrow_function", "function_expression"):
                nm = _name_of(ctx, ch)
                if nm:
                    out.append((nm, "function", *ctx.span(ch)))
            elif k in _CLASS_KINDS:
                nm = _name_of(ctx, ch)
                if nm:
                    out.append((nm, "class", *ctx.span(ch)))
            elif k in ("lexical_declaration", "variable_declaration"):
                for d in ctx.children(ch):
                    if d.kind() != "variable_declarator":
                        continue
                    dch = ctx.children(d)
                    if dch and dch[0].kind() in _NAME_KINDS:
                        is_fn = any(c.kind() in _FUNCLIKE for c in dch)
                        out.append((ctx.text(dch[0]), "function" if is_fn else "constant", *ctx.span(ch)))
    seen: set[str] = set()
    return [m for m in out if not (m[0] in seen or seen.add(m[0]))]


def scan_module_consumers(repo: str, anchor_file: str, member_names: set[str],
                          pkgs: dict[str, str]) -> list[tuple[str, dict[str, str]]]:
    """One repo walk → [(consumer_file, {member → local binding})] for every file whose import of
    one or more of `member_names` RESOLVES to `anchor_file`. Member co-occurrence (the §11.1 intent
    signal) is read straight from these named imports — no call-site resolution needed."""
    anchor_norm = os.path.normpath(anchor_file)
    anchor_abs = os.path.normpath(os.path.join(repo, anchor_file))
    out: list[tuple[str, dict[str, str]]] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_EXTS):
                continue
            path = os.path.join(root, fn)
            if os.path.normpath(path) == anchor_abs:
                continue
            try:
                text = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if not any(m in text for m in member_names):
                continue
            rel = os.path.relpath(path, repo)
            used: dict[str, str] = {}
            for m in _IMPORT_RE.finditer(text):
                named, source = m.group(2), m.group(3)
                if not named:
                    continue
                resolved_to = resolve_module(repo, rel, source, pkgs)
                if resolved_to is None or os.path.normpath(resolved_to) != anchor_norm:
                    continue
                for part in named.split(","):
                    ln = _local_name(part)
                    if ln and ln[0] in member_names:
                        used.setdefault(ln[0], ln[1])
            if used:
                out.append((rel, used))
    return out


def build_module_graph(repo: str, anchor_file: str) -> dict:
    """MULTI-MEMBER mode: anchor = a whole MODULE; carriers = its exported members; consumers wire
    to the SPECIFIC members they import (so member co-occurrence → the intent partition, §11.1).
    Node ids are the member SYMBOL names (the anchor module is `mod`), so a hand gold can score it."""
    repo = os.path.expanduser(repo)
    mod_name = os.path.splitext(os.path.basename(anchor_file))[0]
    ar = _read(repo, anchor_file)
    if not ar or not available():
        raise RuntimeError(f"cannot parse anchor module {anchor_file}")
    ctx = _Ctx(ar[0], ar[1])
    members = _exported_members(ctx)
    mlen = ar[0].count("\n")
    nodes: list[dict] = [{"id": "mod", "symbol": mod_name, "kind": "module", "file": anchor_file,
                          "range": [0, mlen], "enclosing": "", "complexity": max(1, mlen)}]
    for name, kind, s, e in members:
        nodes.append({"id": name, "symbol": name, "kind": kind, "file": anchor_file,
                      "range": [s, e], "enclosing": mod_name, "complexity": max(1, e - s + 1)})

    edges: list[dict] = []
    member_names = {m[0] for m in members}
    pkgs = _pkg_map(repo)
    counter = 0
    for cfile, used in scan_module_consumers(repo, anchor_file, member_names, pkgs):
        counter += 1
        # best-effort: name the consumer node by the enclosing symbol at a member's first call-site
        sym, kind = os.path.splitext(os.path.basename(cfile))[0], "module"
        rng = [0, 0]
        rd = _read(repo, cfile)
        if rd:
            try:
                cctx = _Ctx(rd[0], rd[1])
                units = _named_units(cctx)
                line = next((ln for local in used.values() for ln in _call_lines(cctx, local)), None)
                enc = _enclosing(units, line) if line is not None else None
                if enc:
                    sym, kind, rng = enc[0], enc[1], [enc[2], enc[3]]
            except Exception:
                pass
        cid = f"c{counter}"
        nodes.append({"id": cid, "symbol": sym, "kind": kind, "file": cfile,
                      "range": rng, "enclosing": "", "complexity": 1})
        for mname in sorted(used):
            edges.append({"from": cid, "to": mname, "kind": "reference", "provenance": "RESOLVED_FULL"})

    return {
        "version": 1,
        "anchor": {"id": "mod", "symbol": mod_name, "file": anchor_file, "range": [0, mlen]},
        "language": (lang_for(anchor_file) or ""),
        "resolutionQuality": "FULL",
        "depth": 1,
        "complete": True,
        "nodes": nodes,
        "edges": edges,
        "blindspots": [],
        "unresolved": [],
    }


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Build a ResolvedGraph by deterministic import scan.")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--anchor-file", required=True, help="repo-relative path of the symbol's defining file")
    ap.add_argument("--symbol", help="single-symbol anchor; OMIT for MODULE mode (all exports as members)")
    ap.add_argument("--depth", type=int, default=1, help="1 = direct consumers; 2 = + the environment ripple (consumers-of-consumers)")
    ap.add_argument("--out", help="write the ResolvedGraph JSON here (else stdout)")
    a = ap.parse_args(argv)
    g = build_module_graph(a.repo, a.anchor_file) if not a.symbol \
        else build_resolved_graph(a.repo, a.anchor_file, a.symbol, depth=a.depth)
    text = json.dumps(g, indent=2)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text)
        print(f"ResolvedGraph: {a.out}  ({len(g['nodes'])} nodes, {len(g['edges'])} resolved edges, "
              f"{len(g['blindspots'])} blind spot(s))")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
