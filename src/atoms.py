"""Behavioural ATOMS for Model B — the verified SUBSTRATE (plan `seam-B-…` §1/§4).

Cross-language via tree-sitter (offline-testable; reuses `facts_treesitter`). An atom is a
behavioural unit INSIDE a core: the **outermost nested function-like nodes** (event handlers,
callbacks, methods) of the anchor's body — the units a reader thinks of as "what it does".
Each atom carries the identifier NAMES it references — a GROUPING SIGNAL ONLY: reliable for
locals/params (one lexical scope), name-only for external calls, and NEVER emitted as an edge
(invariant: a suggested partition may group verified atoms; it may not assert a coupling).

Boundaries (atom line ranges) are RESOLVED — exact regions of code. The grouping built on top
(codebase.detect_subcores) is PROPOSED. On ANY failure — no tree-sitter, unsupported grammar,
parse error, fewer than two function-like units — this returns `[]`, so Model B degrades to the
single-core Model A view. It never produces a *wrong* split, only sometimes *no* split.

B1 deliberately splits ONLY on nested function-like units (conservative, avoids spurious
statement-level fragments). Finer granularity (branches / statements / JSX blocks) is a later
step gated on the §5 validation.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .facts_treesitter import _LANG_BY_EXT, _parser, available

# Function-like node kinds across grammars (substring match — names vary per grammar).
_FUNCLIKE = ("arrow_function", "function_definition", "function_declaration",
             "function_expression", "method_definition", "method_declaration",
             "function_item", "lambda")
# The body block of a function (the scope whose children we scan for nested handlers).
_BODYISH = ("block", "body")


@dataclass
class Atom:
    start: int                                  # 0-based file line, inclusive
    end: int
    names: set[str] = field(default_factory=set)  # identifiers referenced (grouping signal only)


def lang_for(file_path: str) -> str | None:
    """tree-sitter grammar for a file, or None (→ no atoms → single-core view)."""
    ext = file_path[file_path.rfind("."):].lower() if "." in file_path else ""
    return _LANG_BY_EXT.get(ext)


def extract_atoms(content: str, lang: str, start_line: int, end_line: int) -> list[Atom]:
    """The outermost function-like units inside the anchor's body (the behavioural atoms).
    `start_line`/`end_line` are 0-based inclusive file lines bounding the anchor. Returns [] on
    any failure or when there are fewer than two units (caller collapses to the single core)."""
    if not available():
        return []
    try:
        root = _parser(lang).parse(content).root_node()
    except Exception:
        return []
    cb = content.encode("utf-8")

    def ln(byte: int) -> int:
        return cb[:byte].count(b"\n")                  # 0-based line of a byte offset

    def span(n):
        return ln(n.start_byte()), ln(n.end_byte())

    def children(n):
        return [n.child(i) for i in range(n.child_count())]

    # 1) the anchor's own FUNCTION node = the function-like node whose start best aligns with the
    #    anchor's start line (robust to an end line that slightly over/undershoots the symbol).
    all_funcs: list = []

    def gather(n) -> None:
        for c in children(n):
            if any(f in c.kind() for f in _FUNCLIKE):
                all_funcs.append(c)
            gather(c)

    gather(root)
    if not all_funcs:
        return []
    anchor_func = min(all_funcs, key=lambda n: (abs(span(n)[0] - start_line), -(span(n)[1] - span(n)[0])))
    if abs(span(anchor_func)[0] - start_line) > 3:        # no function aligns with the anchor → no split
        return []

    # 2) the anchor function's OWN body block — its DIRECT block/body child (not a nested one),
    #    so we scan INSIDE the anchor while excluding the anchor function itself.
    body = anchor_func
    for c in children(anchor_func):
        if any(b in c.kind() for b in _BODYISH):
            body = c
            break

    # 3) outermost function-like nodes inside the body (don't descend into one already taken).
    funcs: list = []

    def walk(n) -> None:
        for c in children(n):
            if any(f in c.kind() for f in _FUNCLIKE):
                funcs.append(c)
            else:
                walk(c)

    walk(body)

    def names_of(n) -> set[str]:
        out: set[str] = set()
        stack = [n]
        while stack:
            x = stack.pop()
            if "identifier" in x.kind():
                out.add(cb[x.start_byte():x.end_byte()].decode("utf-8", "replace"))
            stack.extend(children(x))
        return out

    atoms: list[Atom] = []
    for n in funcs:
        s, e = span(n)
        if s < start_line or e > end_line:
            continue
        atoms.append(Atom(start=s, end=e, names=names_of(n)))
    return atoms
