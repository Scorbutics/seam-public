"""Tree-sitter SUBSTRATE for the codebase product's intra-anchor decomposition.

Cross-language (reuses `facts_treesitter`), offline-testable. Two extractors over the same
verified substrate — boundaries are RESOLVED (real code regions), the readings built on top
(codebase.py) are graded link/environment/PROPOSED:

  - `extract_atoms`     — Model B: the outermost nested function-like units inside the anchor
                          (handlers/callbacks). Behavioural sub-cores group these.
  - `extract_contract`  — Model A: the anchor's parameters / props (its contract surface), each
                          with where it's used in the body and whether it is INVOKED there (a
                          called callback = a behavioural link; a read-only prop = environment).

On ANY failure (no tree-sitter, unsupported grammar, parse error, no aligned function) both
return `[]` → the feature degrades off; never a wrong result.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..core.treesitter import _LANG_BY_EXT, _parser, available

# ---------------------------------------------------------------------------------------------
# PER-GRAMMAR NODE-KIND REGISTRY (F1). The extractors reason over CONCEPTS, never literal TSX
# kinds, so the substrate is language-parametric (no React/TS assumptions). Each set is the UNION
# of the kinds every supported grammar uses for that concept — kinds rarely collide across
# grammars, so a union needs no per-language dispatch while still covering each. Unknown grammar /
# missing concept → the set just doesn't match → empty extraction → graceful degradation.
# Probed real (tree-sitter): TS/TSX, C/C++ (litergss3), + Java/Python/Rust/Go/Ruby from grammar docs.
_FUNCLIKE = {
    # TS/JS:                      C/C++:                  Java:                  Python/Rust/Ruby:
    "arrow_function", "function_declaration", "function_expression", "method_definition",
    "generator_function_declaration", "function_signature",
    "function_definition", "lambda_expression",                       # C/C++ (+ Java lambda)
    "method_declaration", "constructor_declaration",                  # Java
    "function_item", "closure_expression",                            # Rust
    "lambda", "function",                                             # Python / generic
    "method",                                                         # Ruby/generic
}
_BODY = {
    "statement_block",                 # TS/JS
    "compound_statement",              # C/C++  (the kind the old block/body check MISSED)
    "block", "constructor_body",       # Java / generic
    "function_body", "do_block",       # Ruby / generic
}
_PARAM_LIST = {
    "formal_parameters",               # TS/JS, Java
    "parameter_list",                  # C/C++
    "parameters",                      # Python / Rust
    "method_parameters",               # generic
}
_PARAM_NODE = {
    "required_parameter", "optional_parameter", "rest_pattern",       # TS/JS
    "parameter_declaration", "optional_parameter_declaration",        # C/C++
    "formal_parameter", "spread_parameter", "receiver_parameter",     # Java
    "typed_parameter", "default_parameter", "typed_default_parameter",# Python
    "parameter",                                                      # Rust / generic
}
_CALL = {
    "call_expression",                 # TS/JS, C/C++, Rust
    "method_invocation",               # Java
    "call",                            # Python / Ruby
    "invocation_expression",           # C#
}


@dataclass
class Atom:
    start: int                                  # 0-based file line, inclusive
    end: int
    names: set[str] = field(default_factory=set)  # identifiers referenced (grouping signal only)


@dataclass
class ContractMember:
    name: str
    invoked: bool                               # called in the body (a behavioural callback) vs read-only
    ranges: list = field(default_factory=list)  # [[start,end],…] internal-use line ranges (0-based)


# --------------------------------------------------------------------------- shared substrate
def lang_for(file_path: str) -> str | None:
    ext = file_path[file_path.rfind("."):].lower() if "." in file_path else ""
    return _LANG_BY_EXT.get(ext)


class _Ctx:
    """A parsed file with byte→line + node helpers (binding accessors are callables)."""
    def __init__(self, content: str, lang: str):
        self.cb = content.encode("utf-8")
        self.root = _parser(lang).parse(content).root_node()

    def ln(self, byte: int) -> int:
        return self.cb[:byte].count(b"\n")

    def span(self, n):
        return self.ln(n.start_byte()), self.ln(n.end_byte())

    def children(self, n):
        return [n.child(i) for i in range(n.child_count())]

    def text(self, n) -> str:
        return self.cb[n.start_byte():n.end_byte()].decode("utf-8", "replace")

    def col(self, byte: int) -> int:                  # 0-based column of a byte offset
        return byte - (self.cb.rfind(b"\n", 0, byte) + 1)

    def collect(self, root, pred) -> list:
        out, st = [], [root]
        while st:
            x = st.pop()
            if pred(x.kind()):
                out.append(x)
            st.extend(self.children(x))
        return out


def _anchor_func(ctx: _Ctx, start_line: int):
    """The function-like node whose start best aligns with the anchor's start line (robust to a
    slightly off end). None if nothing aligns within a few lines (→ no decomposition)."""
    funcs = ctx.collect(ctx.root, lambda k: k in _FUNCLIKE)
    if not funcs:
        return None
    af = min(funcs, key=lambda n: (abs(ctx.span(n)[0] - start_line), -(ctx.span(n)[1] - ctx.span(n)[0])))
    return af if abs(ctx.span(af)[0] - start_line) <= 3 else None


def _body_of(ctx: _Ctx, func):
    """The function's body block. A direct child for most grammars (TS `statement_block`, C++
    `compound_statement`); falls back to the func node itself for concise bodies."""
    for c in ctx.children(func):
        if c.kind() in _BODY:
            return c
    return func


def _param_list(ctx: _Ctx, func):
    """The function's OWN parameter list. Robust to grammar structure: in TS it's a direct child
    (`formal_parameters`); in C/C++ it sits under `function_declarator`. BFS from the function,
    NOT descending into the body or a nested function, so we never grab an inner call/lambda's
    params."""
    queue = list(ctx.children(func))
    while queue:
        c = queue.pop(0)
        k = c.kind()
        if k in _PARAM_LIST:
            return c
        if k in _BODY or k in _FUNCLIKE:
            continue                                      # don't descend into body / nested fn
        queue.extend(ctx.children(c))
    return None


def _param_names(ctx: _Ctx, param_node) -> list[str]:
    """The binding name(s) of one parameter. A destructured object param (TS `{a, b}`) yields its
    field names; otherwise the parameter's name identifier (the last plain `identifier` in source
    order — after the type, before nothing, for `Type name` / `name`)."""
    fields = ctx.collect(param_node, lambda k: "shorthand_property_identifier_pattern" in k)
    if fields:
        return [ctx.text(f) for f in fields]
    ids = sorted((c for c in ctx.collect(param_node, lambda k: k == "identifier")),
                 key=lambda n: n.start_byte())
    return [ctx.text(ids[-1])] if ids else []


def _merge_lines(lines: list[int]) -> list:
    out: list = []
    for l in sorted(set(lines)):
        if out and l <= out[-1][1] + 1:
            out[-1][1] = l
        else:
            out.append([l, l])
    return out


# --------------------------------------------------------------------------- Model B: atoms
def extract_atoms(content: str, lang: str, start_line: int, end_line: int) -> list[Atom]:
    if not available():
        return []
    try:
        ctx = _Ctx(content, lang)
    except Exception:
        return []
    func = _anchor_func(ctx, start_line)
    if func is None:
        return []
    body = _body_of(ctx, func)

    funcs: list = []

    def walk(n) -> None:
        for c in ctx.children(n):
            if c.kind() in _FUNCLIKE:
                funcs.append(c)
            else:
                walk(c)

    walk(body)
    atoms: list[Atom] = []
    for n in funcs:
        s, e = ctx.span(n)
        if s < start_line or e > end_line:
            continue
        names = {ctx.text(i) for i in ctx.collect(n, lambda k: "identifier" in k)}
        atoms.append(Atom(start=s, end=e, names=names))
    return atoms


# --------------------------------------------------------------------------- Model A: contract
def extract_contract(content: str, lang: str, start_line: int, end_line: int) -> list[ContractMember]:
    """The anchor's contract members (parameters / destructured props) used in its body, each
    flagged `invoked` (called → a behavioural link) and with its internal-use line ranges.
    Language-parametric via the node-kind registry — works for a TS component's destructured props
    AND a C++/Java/C function's parameters (the param list may sit under a declarator, not as a
    direct child).

    Handles: destructured in the signature `({a, b}: T)`, destructured in the body
    `const { a, b } = props`, and plain typed params `Type name` (C/C++/Java). Renamed/nested
    destructures and default values are best-effort.
    """
    if not available():
        return []
    try:
        ctx = _Ctx(content, lang)
    except Exception:
        return []
    func = _anchor_func(ctx, start_line)
    if func is None:
        return []
    body = _body_of(ctx, func)

    plist = _param_list(ctx, func)
    sig_fields: set[str] = set()        # destructured props (TS `{a,b}`)
    plain_params: set[str] = set()      # named params (C++/Java/TS `props`) + destructure sources
    if plist is not None:
        for p in ctx.children(plist):
            if p.kind() not in _PARAM_NODE and p.kind() != "identifier":
                continue                                   # punctuation / commas
            if ctx.collect(p, lambda k: "object_pattern" in k):
                sig_fields.update(_param_names(ctx, p))     # destructured → field names
            else:
                plain_params.update(_param_names(ctx, p))   # named parameter

    # body destructure (TS only — fires only where object_pattern exists): `const {a,b} = props`
    body_fields: set[str] = set()
    sources: set[str] = set()
    for d in ctx.collect(body, lambda k: k == "variable_declarator"):
        ch = ctx.children(d)
        if len(ch) < 2:
            continue
        pat, val = ch[0], ch[-1]
        if "object_pattern" in pat.kind() and val.kind() == "identifier" and ctx.text(val) in plain_params:
            sources.add(ctx.text(val))
            for f in ctx.collect(pat, lambda k: "shorthand_property_identifier_pattern" in k):
                body_fields.add(ctx.text(f))

    contract = sig_fields | body_fields | (plain_params - sources)
    if not contract:
        return []

    idents = ctx.collect(body, lambda k: "identifier" in k)
    called = {ctx.text(ctx.children(c)[0]) for c in ctx.collect(body, lambda k: k in _CALL)
              if ctx.children(c) and "identifier" in ctx.children(c)[0].kind()}

    members: list[ContractMember] = []
    for name in sorted(contract):
        occ = [ctx.span(i)[0] for i in idents if ctx.text(i) == name]
        if not occ:
            continue                                       # declared but unused in the body → skip
        members.append(ContractMember(name=name, invoked=name in called, ranges=_merge_lines(occ)))
    return members


def extract_consumer_feeds(content: str, lang: str, anchor_name: str) -> dict:
    """Model A2: at a CONSUMER, which value it feeds to each prop of the anchor — completing the
    thread consumer → prop → internal use. JSX-first (named attributes are the clean, common
    case): for every `<Anchor …/>` usage, map `propName` → the passed value EXPRESSION + line.
    Deterministic from the consumer's AST (the binding is real, RESOLVED); resolving the value's
    *definition* is a further LSP step (not done here). Positional/kwarg calls are best-effort,
    left for later. Returns {propName: [{value, line}]}.
    """
    if not available():
        return {}
    try:
        ctx = _Ctx(content, lang)
    except Exception:
        return {}
    feeds: dict = {}
    elements = ctx.collect(ctx.root, lambda k: k in ("jsx_opening_element", "jsx_self_closing_element"))
    for el in elements:
        tag = next((c for c in ctx.children(el)
                    if c.kind() in ("identifier", "member_expression", "nested_identifier")), None)
        if tag is None or ctx.text(tag) != anchor_name:
            continue
        for attr in (c for c in ctx.children(el) if c.kind() == "jsx_attribute"):
            ch = ctx.children(attr)
            pname = next((ctx.text(c) for c in ch
                          if "property_identifier" in c.kind() or c.kind() == "identifier"), None)
            if not pname:
                continue
            valnode = next((c for c in ch if c.kind() in ("jsx_expression", "string")), None)
            vnode = None
            if valnode is None:
                value = "true"                             # boolean shorthand `<X disabled/>`
            elif valnode.kind() == "jsx_expression":
                inner = [c for c in ctx.children(valnode) if c.is_named()]
                vnode = inner[0] if inner else valnode
                value = ctx.text(vnode)
            else:
                vnode = valnode
                value = ctx.text(valnode)
            feed = {"value": value.strip(), "line": ctx.span(attr)[0]}
            if vnode is not None:                          # the value's precise position (for A3 def resolution)
                feed["valLine"], feed["valCol"] = ctx.span(vnode)[0], ctx.col(vnode.start_byte())
            feeds.setdefault(pname, []).append(feed)
    return feeds
