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
from .languages.base import SKIP_DIRS as _SKIP_DIRS         # shared walk skip-dirs (generic)
from .languages.typescript import _pkg_map, resolve_module  # the TS/JS deterministic floor (per-language)

_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts")
# A consumer in a test file is VERIFICATION (the `test` role), not an in-footprint link or a
# boundary intent — so it's separated out (mirrors resolver.ts TEST_PATH). Covers `*.test.ts` /
# `*.spec.ts` and `tests/` `__tests__/` `spec/` dirs.
_TEST_RE = re.compile(r"(\.(test|spec)\.[a-z]+$)|((^|/)(tests?|__tests__|spec)/)", re.I)


def _kind_for(file: str, kind: str) -> str:
    """A consumer node's kind, overriding to 'test' for test files (→ the `test` role)."""
    return "test" if _TEST_RE.search(file.replace("\\", "/")) else kind

# tree-sitter declaration kinds that carry a name → an enclosing symbol (a consumer unit).
_METHOD_KINDS = {"method_definition", "method_declaration", "constructor_declaration"}
_CLASS_KINDS = {"class_declaration", "class_definition", "class_specifier", "struct_specifier"}
_NAME_KINDS = {"identifier", "property_identifier", "type_identifier"}




# --------------------------------------------------------------------------- resolver injection (P0)
# The scan resolves imports through `_resolve`, which uses the process's ACTIVE resolver (set by the
# CLI's --resolver, e.g. an LspResolver) or, by default, the deterministic floor above. This is the
# one seam where stack-specific resolution can be swapped for a real language server (see resolver.py).
_ACTIVE_RESOLVER = None


def set_resolver(r) -> None:
    """Install the process-wide resolver (None ⇒ the deterministic floor). Set once by the CLI."""
    global _ACTIVE_RESOLVER
    _ACTIVE_RESOLVER = r


def _resolve(repo: str, importing_file: str, source: str, pkgs: dict[str, str]) -> str | None:
    if _ACTIVE_RESOLVER is not None:
        return _ACTIVE_RESOLVER.resolve_module(repo, importing_file, source)
    return resolve_module(repo, importing_file, source, pkgs)


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
                resolved_to = _resolve(repo, rel, source, pkgs)
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


def _ref_lines(ctx: _Ctx, local: str) -> list[int]:
    """0-based lines where `local` appears as an identifier — ANY reference, not just a call (a TYPE
    position like `implements IRoleManager`, an annotation, a `new X()`). Lets a consumer that USES a
    symbol without calling it still land on the real usage line / enclosing symbol, not file:0."""
    return sorted({ctx.span(i)[0] for i in ctx.collect(ctx.root, lambda k: "identifier" in k)
                   if ctx.text(i) == local})


def _usage_lines(ctx: _Ctx, units: list, local: str) -> list[int]:
    """Where to anchor a consumer of `local`: its call-sites; else references INSIDE a named unit
    (so the node gets the real class/function); else the remaining references (a module-level
    `new X()`) MINUS the import line, so navigation still lands on a real usage rather than file:0.
    Empty only if the symbol is imported but never referenced."""
    calls = _call_lines(ctx, local)
    if calls:
        return calls
    refs = _ref_lines(ctx, local)
    inside = [ln for ln in refs if _enclosing(units, ln)]
    return inside or refs[1:]                         # refs[0] is the import; the rest are usages


def _read(repo: str, rel: str) -> tuple[str, str] | None:
    lang = lang_for(rel)
    if not lang:
        return None
    try:
        return open(os.path.join(repo, rel), encoding="utf-8", errors="ignore").read(), lang
    except OSError:
        return None


# --------------------------------------------------------------------------- CLASS method attribution
def _class_methods(ctx: _Ctx, class_name: str) -> list[tuple[str, int, int]]:
    """The behavioural methods of `class_name` as (name, start, end) — the carriers for a class
    anchor. Excludes the constructor (not an intent-bearing behaviour)."""
    cls = next((c for c in ctx.collect(ctx.root, lambda k: k in _CLASS_KINDS)
                if _name_of(ctx, c) == class_name), None)
    if cls is None:
        return []
    out: list[tuple[str, int, int]] = []
    for m in ctx.collect(cls, lambda k: k in ("method_definition", "method_declaration")):
        nm = next((ctx.text(c) for c in ctx.children(m) if c.kind() == "property_identifier"), None)
        if nm and nm != "constructor":
            s, e = ctx.span(m)
            out.append((nm, s, e))
    seen: set[str] = set()
    return [x for x in out if not (x[0] in seen or seen.add(x[0]))]


def _is_new_of(ctx: _Ctx, node, class_name: str) -> bool:
    if node.kind() != "new_expression":
        return False
    cons = next((c for c in ctx.children(node) if c.kind() in ("identifier", "member_expression")), None)
    return cons is not None and ctx.text(cons) == class_name


def _instances_of(ctx: _Ctx, class_name: str) -> set[str]:
    """Names bound to an INSTANCE of `class_name` in this file — conservative & instance-aware
    (the heuristic's precision): `new ClassName()` bindings and `: ClassName`-typed vars / params /
    constructor-injected fields. The binding may also be reached via `this.<name>`."""
    names: set[str] = set()
    binders = ("variable_declarator", "required_parameter", "optional_parameter",
               "public_field_definition", "property_signature", "field_definition")
    for node in ctx.collect(ctx.root, lambda k: k in binders):
        nm = next((ctx.text(c) for c in ctx.children(node) if c.kind() in _NAME_KINDS), None)
        if not nm:
            continue
        typed = any(ctx.text(t) == class_name for t in ctx.collect(node, lambda k: k == "type_identifier"))
        newed = any(_is_new_of(ctx, nx, class_name) for nx in ctx.collect(node, lambda k: k == "new_expression"))
        if typed or newed:
            names.add(nm)
    return names


def _class_call_sites(ctx: _Ctx, methods: set[str]) -> list[tuple[str, int, int]]:
    """EVERY `<expr>.<method>(…)` call whose `method` ∈ `methods`, as (method, line, col) of the
    method identifier — regardless of receiver. These are the candidates an LSP go-to-definition
    verifies (does this call bind to the anchor class's method?), which catches the DI / untyped
    receivers the conservative instance-aware heuristic can't trace."""
    out: list[tuple[str, int, int]] = []
    for call in ctx.collect(ctx.root, lambda k: k == "call_expression"):
        ch = ctx.children(call)
        fn = ch[0] if ch else None
        if fn is None or fn.kind() != "member_expression":
            continue
        prop = next((c for c in ctx.children(fn) if c.kind() == "property_identifier"), None)
        if prop is not None and ctx.text(prop) in methods:
            out.append((ctx.text(prop), ctx.span(prop)[0], ctx.col(prop.start_byte())))
    return out


def class_call_candidates(repo: str, anchor_file: str, class_name: str) -> list[dict]:
    """For the EXTENSION's LSP verification pass: every consumer call-site whose method name matches
    a method of `class_name`, with its position. The extension runs go-to-definition at each and
    keeps the ones resolving into the anchor class — the RESOLVED (type-verified) attribution that
    upgrades / completes the instance-aware heuristic. Pure scan; no graph, no decomposition."""
    repo = os.path.expanduser(repo)
    ar = _read(repo, anchor_file)
    if not ar or not available():
        return []
    methods = {m[0] for m in _class_methods(_Ctx(ar[0], ar[1]), class_name)}
    if not methods:
        return []
    pkgs = _pkg_map(repo)
    out: list[dict] = []
    for con in scan_consumers(repo, anchor_file, class_name):
        if con.status != "resolved":
            continue
        rd = _read(repo, con.file)
        if not rd:
            continue
        try:
            cctx = _Ctx(rd[0], rd[1])
        except Exception:
            continue
        for method, line, col in _class_call_sites(cctx, methods):
            out.append({"file": con.file, "line": line, "col": col, "method": method})
    return out


def _class_method_usage(ctx: _Ctx, class_name: str, methods: set[str]) -> dict[str, int]:
    """{method → first call line} for methods of `class_name` invoked on a TRACED instance: a name
    bound to `new ClassName()`, or one EXPLICITLY typed `: ClassName` (param / DI field), or
    `new ClassName().m()` / `this.field.m()` directly. Either way the receiver is a type-checked
    reference to the class itself — so the attribution is RESOLVED (certain), not a guess. A `.m()`
    on an UNTYPED receiver is NOT attributed here (it's the call-site scan's job, RESOLVED_PARTIAL)."""
    inst = _instances_of(ctx, class_name)
    used: dict[str, int] = {}
    for call in ctx.collect(ctx.root, lambda k: k == "call_expression"):
        ch = ctx.children(call)
        fn = ch[0] if ch else None
        if fn is None or fn.kind() != "member_expression":
            continue
        mch = ctx.children(fn)
        obj = mch[0] if mch else None
        prop = next((c for c in mch if c.kind() == "property_identifier"), None)
        if obj is None or prop is None:
            continue
        m = ctx.text(prop)
        if m not in methods:
            continue
        hit = ((obj.kind() == "identifier" and ctx.text(obj) in inst)
               or (obj.kind() == "new_expression" and _is_new_of(ctx, obj, class_name))
               or (obj.kind() == "member_expression"
                   and (ip := next((c for c in ctx.children(obj) if c.kind() == "property_identifier"), None))
                   and ctx.text(ip) in inst))
        if hit:
            used.setdefault(m, ctx.span(call)[0])
    return used


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
                resolved_to = _resolve(repo, rel, source, pkgs)
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
                line = next(iter(_usage_lines(cctx, units, local)), 0)
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
                    new_nodes.append({"id": d2id, "symbol": name, "kind": _kind_for(rel, kind), "file": rel,
                                      "range": [start, end], "enclosing": "", "complexity": max(1, end - start + 1)})
                if d2id != tid:
                    new_edges.append({"from": d2id, "to": tid, "kind": "reference", "provenance": "RESOLVED_FULL"})
    return new_nodes, new_edges, counter


# --------------------------------------------------------------------------- ResolvedGraph build
def build_resolved_graph(repo: str, anchor_file: str, symbol: str, *, depth: int = 1,
                         verified: dict | None = None, anchor_line: int | None = None) -> dict:
    """Assemble the `ResolvedGraph` JSON (resolver.ts contract) from a deterministic import scan.
    Anchor = the symbol's definition; nodes = the enclosing symbol at each resolved consumer's
    call-site; resolved edges = consumer → anchor. Unresolved-module name matches become
    SUGGESTED blindspots (honest under-claim), never resolved edges. A CLASS anchor delegates to
    `build_class_graph` (passing `verified` — the LSP-confirmed method attribution, if any)."""
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
    if anchor_line is not None:                          # match the EXISTING node's line so merge dedups
        arange = [anchor_line, max(anchor_line, arange[1])]
    # A CLASS anchor decomposes into its METHODS (carriers) — consumers are attributed per-method
    # so the class splits by behavioural intent (charge/refund vs validate), not lumped by area.
    if akind == "class":
        return build_class_graph(repo, anchor_file, symbol, depth=depth, verified=verified)
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
        lines = _usage_lines(cctx, units, con.local) or [0]
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
            nodes.append({"id": cid, "symbol": name, "kind": _kind_for(con.file, kind), "file": con.file,
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
                resolved_to = _resolve(repo, rel, source, pkgs)
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
                line = next((ln for local in used.values() for ln in _usage_lines(cctx, units, local)), None)
                enc = _enclosing(units, line) if line is not None else None
                if enc:
                    sym, kind, rng = enc[0], enc[1], [enc[2], enc[3]]
            except Exception:
                pass
        cid = f"c{counter}"
        nodes.append({"id": cid, "symbol": sym, "kind": _kind_for(cfile, kind), "file": cfile,
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


def build_class_graph(repo: str, anchor_file: str, class_name: str, *, depth: int = 1,
                      verified: dict | None = None) -> dict:
    """CLASS mode: anchor = a class; carriers = its METHODS; each consumer is attributed to the
    method(s) it calls. Two attribution sources, same shape ({consumer_file: {method: line}}):

      - `verified` given  → the EXTENSION's LSP go-to-definition result (type-verified) → edges are
        RESOLVED_FULL. Catches DI / untyped receivers the heuristic can't trace.
      - `verified` is None → the instance-aware tree-sitter heuristic (`new`/typed/`this.field`) →
        edges RESOLVED_PARTIAL (conservative; under-attributes, never lies). The degrade path when
        no LSP is available.

    Methods are member nodes (enclosing = class) wired to the class by containment, so co-occurrence
    + roles + wellformedness reuse the existing machinery. A consumer with no attributed method wires
    to the class and is flagged a blind spot (honest under-attribution)."""
    repo = os.path.expanduser(repo)
    ar = _read(repo, anchor_file)
    if not ar or not available():
        raise RuntimeError(f"cannot parse class anchor {anchor_file}")
    ctx = _Ctx(ar[0], ar[1])
    cls = next((c for c in ctx.collect(ctx.root, lambda k: k in _CLASS_KINDS) if _name_of(ctx, c) == class_name), None)
    crange = list(ctx.span(cls)) if cls is not None else [0, 0]
    methods = _class_methods(ctx, class_name)
    method_names = {m[0] for m in methods}
    method_span = {m[0]: (m[1], m[2]) for m in methods}

    blindspots: list[dict] = []
    unresolved: list[dict] = []

    # PASS 1: scan consumers, attribute methods. Collect which methods are actually USED so only
    # PARTICIPATING methods become carriers (an unused method isn't part of any consumer's intent —
    # showing it as an isolated core would be noise; it's summarised instead).
    pending: list[tuple[str, str, str, int, int, dict]] = []   # (file, sym, kind, start, end, usage)
    used_methods: set[str] = set()
    for con in scan_consumers(repo, anchor_file, class_name):
        if con.status == "suggested":
            blindspots.append({"node": class_name, "mechanism": "unresolved-import",
                               "evidence": f"{con.file} imports {class_name} from '{con.source}' (module unresolved)",
                               "candidates": [{"symbol": con.file}]})
            unresolved.append({"node": class_name, "query": "resolveModule", "reason": f"unresolved:{con.source}"})
            continue
        rd = _read(repo, con.file)
        if not rd:
            continue
        try:
            cctx = _Ctx(rd[0], rd[1])
        except Exception:
            continue
        # MERGE: the LSP is ADDITIVE precision on the heuristic FLOOR, never a replacement. Per
        # consumer: LSP-verified → RESOLVED_FULL; LSP silent (interface-typed / factory / DI it
        # couldn't follow) → fall back to the tree-sitter heuristic → RESOLVED_PARTIAL. This stops a
        # flaky/partial LSP from LOSING the coverage the heuristic already had.
        if verified is not None and (v := {m: ln for m, ln in (verified.get(con.file) or {}).items()
                                           if m in method_names}):
            usage = v                                                   # LSP-verified
        else:
            usage = {m: ln for m, ln in _class_method_usage(cctx, class_name, method_names).items()
                     if m in method_names}
        # the receiver is a type-checked reference to the class (newed or `: Class`-typed) — RESOLVED.
        # (Untyped, name-only matches don't reach here; they're the call-site scan's RESOLVED_PARTIAL.)
        prov = "RESOLVED_FULL"
        units = _named_units(cctx)
        # a traced method call gives the line; otherwise anchor on where the CLASS itself is
        # referenced (`new X()`, a type position) so an untraced consumer still lands on a real line.
        line = min(usage.values()) if usage else next(iter(_usage_lines(cctx, units, con.local)), 0)
        enc = _enclosing(units, line)
        sym, kind, start, end = enc if enc else (os.path.splitext(os.path.basename(con.file))[0], "module", line, line)
        pending.append((con.file, sym, kind, start, end, usage, prov))
        used_methods |= set(usage)

    # carriers = only the PARTICIPATING methods (≥1 traced consumer)
    nodes: list[dict] = [{"id": class_name, "symbol": class_name, "kind": "class", "file": anchor_file,
                          "range": crange, "enclosing": "", "complexity": max(1, crange[1] - crange[0] + 1)}]
    edges: list[dict] = []
    for mn in sorted(used_methods):
        s, e = method_span[mn]
        nodes.append({"id": f"{class_name}.{mn}", "symbol": mn, "kind": "method", "file": anchor_file,
                      "range": [s, e], "enclosing": class_name, "complexity": max(1, e - s + 1)})
        edges.append({"from": f"{class_name}.{mn}", "to": class_name, "kind": "contains", "provenance": "RESOLVED_FULL"})
    unused = method_names - used_methods
    if unused:                                       # honest coverage note, not N isolated-core warnings
        blindspots.append({"node": class_name, "mechanism": "untraced-or-unused-methods",
                           "evidence": f"{len(unused)} of {len(method_names)} methods have no traced consumer "
                                       f"(unused, or used via an instance we couldn't trace): {', '.join(sorted(unused))}",
                           "candidates": []})

    # PASS 2: emit consumer nodes + method-attribution edges (per-consumer provenance from the merge).
    counter = 0
    seen_keys: dict[str, str] = {}
    n_methods = len(used_methods)
    untraced: list[str] = []
    for cfile, sym, kind, start, end, usage, prov in pending:
        counter += 1
        cid = f"c{counter}"
        seen_keys[f"{cfile}#{sym}#{start}"] = cid
        nodes.append({"id": cid, "symbol": sym, "kind": _kind_for(cfile, kind), "file": cfile,
                      "range": [start, end], "enclosing": "", "complexity": max(1, end - start + 1)})
        if usage:
            for mn in sorted(usage):
                edges.append({"from": cid, "to": f"{class_name}.{mn}", "kind": "reference",
                              "provenance": prov, "line": usage[mn]})   # the call-site line in cid's file
        else:                                         # a RESOLVED consumer; method-level detail unavailable
            edges.append({"from": cid, "to": class_name, "kind": "reference", "provenance": "RESOLVED_FULL"})
            untraced.append(cfile)
    if untraced:
        # ONE honest note, candidates=[] so these RESOLVED imports do NOT render as "SUGGESTED" — the
        # reference is a fact; only WHICH method it calls couldn't be pinned (factory/DI/dynamic).
        blindspots.append({"node": class_name, "mechanism": "method-unattributed-consumers",
                           "evidence": f"{len(untraced)} consumer(s) import {class_name} as a RESOLVED reference "
                                       f"but no method call could be attributed to an instance (factory/DI/dynamic): "
                                       f"{', '.join(sorted(untraced))}",
                           "candidates": []})

    if depth >= 2:
        d2_nodes, d2_edges, counter = _depth2_ripple(repo, nodes[1 + n_methods:], _pkg_map(repo), counter, seen_keys)
        nodes.extend(d2_nodes)
        edges.extend(d2_edges)

    return {
        "version": 1,
        "anchor": {"id": class_name, "symbol": class_name, "file": anchor_file, "range": crange},
        "language": (lang_for(anchor_file) or ""),
        "resolutionQuality": "FULL",
        "depth": depth,
        "complete": True,
        "nodes": nodes,
        "edges": edges,
        "blindspots": blindspots,
        "unresolved": unresolved,
    }


def _type_methods(ctx: _Ctx, name: str) -> list[tuple[str, int, int]]:
    """Behavioural method names of a CLASS or an INTERFACE named `name` (so an abstraction's methods
    are known even when only the interface is in hand)."""
    cm = _class_methods(ctx, name)
    if cm:
        return cm
    iface = next((c for c in ctx.collect(ctx.root, lambda k: k == "interface_declaration")
                  if _name_of(ctx, c) == name), None)
    if iface is None:
        return []
    out: list[tuple[str, int, int]] = []
    for m in ctx.collect(iface, lambda k: k in ("method_signature", "property_signature")):
        nm = next((ctx.text(c) for c in ctx.children(m) if c.kind() == "property_identifier"), None)
        if nm:
            s, e = ctx.span(m)
            out.append((nm, s, e))
    seen: set[str] = set()
    return [x for x in out if not (x[0] in seen or seen.add(x[0]))]


def build_callsite_graph(repo: str, anchor_file: str, symbol: str, *, anchor_line: int | None = None) -> dict:
    """CALL-SITE discovery: the anchor (a class/interface) + every place a consumer CALLS one of its
    methods — `x.method(…)` ANYWHERE in the repo, regardless of how `x` was obtained (DI, factory,
    interface typing). This is what makes abstraction usage visible when the concrete class is never
    imported by name. Edges are RESOLVED_PARTIAL: a `.method(` match is a strong-but-not-certain
    signal (a different type with the same method name could collide — distinctive names are safe,
    common ones noisy). Anchor on (file, line) so it merges/dedups with an existing node."""
    repo = os.path.expanduser(repo)
    ar = _read(repo, anchor_file)
    if not ar or not available():
        raise RuntimeError(f"cannot parse anchor {anchor_file}")
    actx = _Ctx(ar[0], ar[1])
    arange, akind = [0, 0], "symbol"
    defu = next((u for u in _named_units(actx) if u[0] == symbol), None)
    if defu:
        akind, arange = defu[1], [defu[2], defu[3]]
    elif any(_name_of(actx, c) == symbol for c in actx.collect(actx.root, lambda k: k == "interface_declaration")):
        akind = "interface"
        ifc = next(c for c in actx.collect(actx.root, lambda k: k == "interface_declaration") if _name_of(actx, c) == symbol)
        arange = list(actx.span(ifc))
    if anchor_line is not None:
        arange = [anchor_line, max(anchor_line, arange[1])]
    methods = {m[0] for m in _type_methods(actx, symbol)}

    nodes = [{"id": "n1", "symbol": symbol, "kind": akind, "file": anchor_file, "range": arange,
              "enclosing": "", "complexity": max(1, arange[1] - arange[0] + 1)}]
    edges: list[dict] = []
    if not methods:
        return {"version": 1, "anchor": {"id": "n1", "symbol": symbol, "file": anchor_file, "range": arange},
                "language": (lang_for(anchor_file) or ""), "resolutionQuality": "FULL", "depth": 1,
                "complete": True, "nodes": nodes, "edges": edges, "blindspots": [], "unresolved": []}

    anchor_abs = os.path.normpath(os.path.join(repo, anchor_file))
    counter = 0
    seen: dict[str, str] = {}
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
            if not any(m in text for m in methods):
                continue
            rel = os.path.relpath(path, repo)
            try:
                cctx = _Ctx(text, lang_for(rel))
            except Exception:
                continue
            units = _named_units(cctx)
            for method, line, _col in _class_call_sites(cctx, methods):
                enc = _enclosing(units, line)
                sym, kind, start, end = enc if enc else (os.path.splitext(fn)[0], "module", line, line)
                key = f"{rel}#{sym}#{start}"
                if key in seen:
                    continue
                counter += 1
                cid = f"c{counter}"
                seen[key] = cid
                nodes.append({"id": cid, "symbol": sym, "kind": _kind_for(rel, kind), "file": rel,
                              "range": [start, end], "enclosing": "", "complexity": max(1, end - start + 1)})
                edges.append({"from": cid, "to": "n1", "kind": "call", "provenance": "RESOLVED_PARTIAL"})

    return {"version": 1, "anchor": {"id": "n1", "symbol": symbol, "file": anchor_file, "range": arange},
            "language": (lang_for(anchor_file) or ""), "resolutionQuality": "FULL", "depth": 1,
            "complete": True, "nodes": nodes, "edges": edges, "blindspots": [], "unresolved": []}


def build_consumers_graph(repo: str, anchor_file: str, symbol: str, *, depth: int = 1,
                          verified: dict | None = None, anchor_line: int | None = None) -> dict:
    """UP / consumers — the COMPLETE "who uses this", one primitive: by-name importers (resolved)
    UNIONED with method CALL-SITES (the DI/factory/interface usage the import scan can't see) when
    the anchor is a class/interface. The LLM (and the human) reasons over one "consumers" move; the
    engine picks the mechanism. Per-edge provenance stays honest (RESOLVED_FULL importers,
    RESOLVED_PARTIAL call-sites). A plain function has no methods, so it's just its importers."""
    from .expand import merge_resolved
    base = build_resolved_graph(repo, anchor_file, symbol, depth=depth, verified=verified, anchor_line=anchor_line)
    ar = _read(repo, anchor_file)
    if ar and available():
        # Call-sites are added ONLY for an INTERFACE — the DI/abstraction case where consumers don't
        # import a concrete class, so the import scan is blind to them. A concrete CLASS is reached
        # fine by its importers; adding its method call-sites would EXPLODE on common method names
        # (every `.update()`/`.getRole()` in the repo). The interface's distinctive methods are safe.
        try:
            ctx = _Ctx(ar[0], ar[1])
            is_interface = any(_name_of(ctx, c) == symbol
                               for c in ctx.collect(ctx.root, lambda k: k == "interface_declaration"))
        except Exception:
            is_interface = False
        if is_interface:
            base = merge_resolved(base, build_callsite_graph(repo, anchor_file, symbol, anchor_line=anchor_line))
    return base


def build_dependency_graph(repo: str, anchor_file: str, symbol: str, *, anchor_line: int | None = None) -> dict:
    """DOWNWARD direction (P3): the anchor's direct DEPENDENCIES — the behavioural symbols its file
    imports (resolved) — so an intent can grow toward what it USES (service → repository → prisma),
    not just who uses it. The source node is promoted to a core (the expand anchor); the deps are
    NOT added to `anchors`, so they're LINKS (wiring adjacent to that core) — following a dependency
    adds connective tissue, not new cores, keeping the core set the deliberate focus. So `down` on a
    core keeps it a core; `down` on a link promotes that link to a core, and its deps are links.
    Type/constant imports fall away naturally (only function/class/method defs are kept); an import
    that doesn't resolve to a repo file (external pkg / alias / DI) becomes a SUGGESTED blind spot —
    the honest dependency boundary."""
    repo = os.path.expanduser(repo)
    nodes: list[dict] = []
    edges: list[dict] = []
    blindspots: list[dict] = []
    arange, akind = [0, 0], "symbol"
    ar = _read(repo, anchor_file)
    if ar and available():
        try:
            defu = next((u for u in _named_units(_Ctx(ar[0], ar[1])) if u[0] == symbol), None)
            if defu:
                akind, arange = defu[1], [defu[2], defu[3]]
        except Exception:
            pass
    if anchor_line is not None:                          # match the EXISTING node's line so merge dedups
        arange = [anchor_line, max(anchor_line, arange[1])]
    nodes.append({"id": "n1", "symbol": symbol, "kind": akind, "file": anchor_file,
                  "range": arange, "enclosing": "", "complexity": max(1, arange[1] - arange[0] + 1)})
    anchors = ["n1"]

    if ar and available():
        pkgs = _pkg_map(repo)
        dep_units: dict[str, list] = {}
        counter = 0
        seen: set[tuple[str, str]] = set()
        external_pkgs: list[str] = []                    # genuine node_modules deps — aggregated, not N spots
        for m in _IMPORT_RE.finditer(ar[0]):
            named, source = m.group(2), m.group(3)
            if not named:
                continue
            resolved_to = _resolve(repo, anchor_file, source, pkgs)
            for part in named.split(","):
                ln = _local_name(part)
                if not ln:
                    continue
                imported = ln[0]
                if resolved_to is None:                  # external pkg / alias / DI → the dependency boundary
                    if source not in external_pkgs:
                        external_pkgs.append(source)
                    continue
                if resolved_to not in dep_units:
                    rd = _read(repo, resolved_to)
                    try:
                        dep_units[resolved_to] = _named_units(_Ctx(rd[0], rd[1])) if rd else []
                    except Exception:
                        dep_units[resolved_to] = []
                defu = next((u for u in dep_units[resolved_to] if u[0] == imported), None)
                if defu is None:                         # not a behavioural top-level def (type/const/re-export)
                    continue
                if (imported, resolved_to) in seen:
                    continue
                seen.add((imported, resolved_to))
                counter += 1
                did = f"d{counter}"
                nodes.append({"id": did, "symbol": imported, "kind": defu[1], "file": resolved_to,
                              "range": [defu[2], defu[3]], "enclosing": "", "complexity": max(1, defu[3] - defu[2] + 1)})
                edges.append({"from": "n1", "to": did, "kind": "import", "provenance": "RESOLVED_FULL"})
                # a followed dependency is NOT added to `anchors` → it's WIRING (a link adjacent to the
                # source, which IS promoted to a core), not a new core. Keeps the core set the focus.

        if external_pkgs:                                # ONE quiet boundary, not a wall of per-lib spots
            shown = ", ".join(external_pkgs[:8]) + (" …" if len(external_pkgs) > 8 else "")
            blindspots.append({"node": "n1", "mechanism": "external-libraries",
                               "evidence": f"{symbol} uses {len(external_pkgs)} external package(s): {shown}",
                               "candidates": []})

    return {
        "version": 1,
        "anchor": {"id": "n1", "symbol": symbol, "file": anchor_file, "range": arange},
        "anchors": anchors,
        "language": (lang_for(anchor_file) or ""),
        "resolutionQuality": "FULL",
        "depth": 1,
        "complete": True,
        "nodes": nodes,
        "edges": edges,
        "blindspots": blindspots,
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
