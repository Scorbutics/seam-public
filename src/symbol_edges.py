"""Deterministic symbol grounding for seam wiring — the FLOOR pass 2 builds on.

Seam wiring is a grounding/tracing problem, not a reasoning one (measured: the LLM
is high-precision but recall-bound, and "thinking" can't recover a reference it
lost track of). So instead of asking the model to DISCOVER edges, we pre-compute
candidate def->use edges from the diff text and let pass 2 CONFIRM/PRUNE them —
converting a hallucination-prone generate task into a reliable validate task.

This is a cheap regex extractor over ADDED lines, restricted to the change's NEW
vocabulary (symbols DEFINED somewhere in the diff). The new-vocab restriction is
the key precision lever: it avoids the "every shared import is an edge" hairball
(measured P~0.95 with it). It is a FLOOR, not a ceiling — informal couplings (wired
by convention, not reference) are invisible here and stay the LLM's job. A tree-
sitter/LSP backend can replace `_defs_refs` later for cross-language robustness
(and to reach unchanged code for the link-only / isolated-core boundary cases).
"""
from __future__ import annotations

import re

from .parser import Hunk

_IDENT = re.compile(r"[A-Za-z_]\w{2,}")  # >=3 chars cuts noise (id, db, ok, ...)
_DEF_PATTERNS = [
    re.compile(r"\b(?:function|class|interface|type|enum)\s+([A-Za-z_]\w*)"),
    re.compile(r"\b(?:const|let|var|val)\s+([A-Za-z_]\w*)"),
    re.compile(r"\b(?:fun|def|object|module)\s+([A-Za-z_]\w*)"),
    re.compile(r"\bexport\s+(?:default\s+)?(?:async\s+)?"
               r"(?:function|class|const|interface|type|enum)\s+([A-Za-z_]\w*)"),
    re.compile(r"\b([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\([^)\n]*\)\s*"
               r"(?::[^=\n]+)?=>"),  # arrow fn assignment
    re.compile(r"(?i)\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?[\"`']?([A-Za-z_]\w*)"),
    re.compile(r"(?i)\balter\s+table\s+[\"`']?([A-Za-z_]\w*)"),
]
# Keywords / ubiquitous tokens that are never a meaningful new symbol.
_STOP = {
    "return", "const", "function", "import", "export", "from", "this", "true",
    "false", "null", "void", "async", "await", "new", "class", "interface",
    "type", "enum", "public", "private", "protected", "static", "the", "and",
    "for", "not", "exists", "table", "create", "alter", "string", "number",
    "boolean", "any", "value", "data", "props", "self", "def", "val", "var",
}


def _added(text: str) -> str:
    return "\n".join(l[1:] for l in text.splitlines() if l.startswith("+"))


def _defs_refs(text: str) -> tuple[set[str], set[str]]:
    """(symbols DEFINED, symbols REFERENCED) on a hunk's added lines."""
    body = _added(text)
    defs: set[str] = set()
    for pat in _DEF_PATTERNS:
        defs.update(m for m in pat.findall(body) if m and m not in _STOP)
    refs = {t for t in _IDENT.findall(body) if t not in _STOP}
    return defs, refs


# import { A, B as C } from "src";  /  import D from "src";  /  import * as E from "src"
# DOTALL so a multi-line `{ ... }` named block (common in TS) is captured whole.
_IMPORT_RE = re.compile(
    r'import\s+(?:type\s+)?'
    r'(?:([A-Za-z_$][\w$]*)\s*,?\s*)?'          # default binding
    r'(?:\*\s*as\s*[A-Za-z_$][\w$]*\s*)?'       # namespace (binding ignored)
    r'(?:\{([^}]*)\}\s*)?'                       # named block (may span lines)
    r'from\s*["\']([^"\']+)["\']',
    re.DOTALL,
)


def _module_root(source: str) -> str:
    """Shorten a module path for display: '@coss/ui/components/toast' -> '@coss/ui',
    'react-inlinesvg/provider' -> 'react-inlinesvg', './GeoContext' -> './GeoContext'."""
    if source.startswith("."):
        return source
    parts = source.split("/")
    return "/".join(parts[:2]) if source.startswith("@") else parts[0]


def _diff_imports(hunks: list[Hunk]) -> dict[str, str]:
    """{imported_symbol: source_module} over ADDED import lines across the whole diff."""
    imp: dict[str, str] = {}
    for h in hunks:
        added = _added(h.text)
        for m in _IMPORT_RE.finditer(added):
            default, named, source = m.group(1), m.group(2), m.group(3)
            if default:
                imp.setdefault(default, source)
            for part in (named or "").split(","):
                name = part.strip().split(" as ")[-1].strip()
                if name:
                    imp.setdefault(name, source)
    return imp


def external_refs(hunks: list[Hunk]) -> dict[str, list[dict[str, str]]]:
    """{hunk_id: [{"symbol","source"}]} — imported symbols a hunk references that are
    defined NOWHERE in the diff. The thing it wires to lives OUTSIDE the change (the
    §I 'diff is not the codebase' boundary). Prefers workspace/scoped (@scope, ./rel)
    sources over ubiquitous runtime libs (react, next, ...): when a scoped/relative
    source is present, drop the bare-lib noise. These (symbol, source) pairs are what
    Layer 2's resolver looks up — where the symbol actually LIVES + its signature.
    Deterministic; no LLM."""
    imp = _diff_imports(hunks)
    new_vocab: set[str] = set().union(*(d for d, _ in (_defs_refs(h.text) for h in hunks))) \
        if hunks else set()
    out: dict[str, list[dict[str, str]]] = {}
    for h in hunks:
        _d, refs = _defs_refs(h.text)
        pairs = [(s, imp[s]) for s in sorted(refs) if s in imp and s not in new_vocab]
        scoped = [(s, src) for s, src in pairs if src and src[0] in "@."]
        chosen = scoped if scoped else pairs
        out[h.id] = [{"symbol": s, "source": src} for s, src in chosen]
    return out


def external_coupling(hunks: list[Hunk]) -> dict[str, list[str]]:
    """{hunk_id: external module ROOTS} — for the '→ @coss/ui' display label. Derived
    from external_refs (the (symbol, source) pairs), reduced to unique module roots."""
    return {hid: sorted({_module_root(r["source"]) for r in rs})
            for hid, rs in external_refs(hunks).items()}


# Salient "subject" of a line: the ROOT of a call/member expression (foo(...),
# bar.baz(...) -> foo, bar — NOT the method `baz`) and JSX component tags (<Foo>).
# The thing the line is ABOUT, not its arguments/props/methods.
_CALL_ROOT = re.compile(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?=[.(])")
_JSX_TAG = re.compile(r"</?\s*([A-Z][\w$]*)")


def _meaningful(s: str) -> bool:
    """Keep component/function-ish names (PascalCase or camelCase: ToastProvider,
    showToast, TIME_UNITS); drop keywords, lowercase locals, and short tokens
    (return, if, item, option, e, t) that are noise in a rewire."""
    return len(s) >= 3 and s not in _STOP and (s[0].isupper() or any(c.isupper() for c in s[1:]))


def _salient_symbols(lines: list[str]) -> set[str]:
    out: set[str] = set()
    for ln in lines:
        out.update(_CALL_ROOT.findall(ln))
        out.update(_JSX_TAG.findall(ln))
    return {s for s in out if _meaningful(s)}


# A crisp rewire is a SMALL swap; beyond this it's a wholesale rewrite (dozens of
# components swapped), which is not a useful "A->B" — the role + external coupling
# already say "this was migrated". Suppress those rather than spew symbol lists.
_REWIRE_MAX = 2


def rewire_pairs(hunks: list[Hunk]) -> dict[str, dict[str, list[str]]]:
    """Per hunk, the A->B REWIRE read straight from its own -/+ lines: meaningful
    subjects (call/member roots, JSX tags) REMOVED vs ADDED, with unchanged ones
    cancelled by set difference. {hunk_id: {"removed":[...], "added":[...]}}.

    Reported only for a SMALL SWAP — both sides non-empty AND each <= _REWIRE_MAX
    (something focused replaced something: `showToast` -> `toastManager`). A pure
    add/delete, or a wholesale rewrite (many symbols), yields empty/empty; those are
    conveyed by the role + external coupling. Layer 1: the §I 're-routes A->B'
    signal, deterministic, no codebase resolution."""
    out: dict[str, dict[str, list[str]]] = {}
    for h in hunks:
        rem_lines, add_lines = [], []
        for ln in h.text.splitlines():
            if ln.startswith("-") and not ln.startswith("---"):
                rem_lines.append(ln[1:])
            elif ln.startswith("+") and not ln.startswith("+++"):
                add_lines.append(ln[1:])
        rem_only = sorted(_salient_symbols(rem_lines) - _salient_symbols(add_lines))
        add_only = sorted(_salient_symbols(add_lines) - _salient_symbols(rem_lines))
        crisp = rem_only and add_only and len(rem_only) <= _REWIRE_MAX and len(add_only) <= _REWIRE_MAX
        out[h.id] = {"removed": rem_only, "added": add_only} if crisp \
            else {"removed": [], "added": []}
    return out


def candidate_wirings(hunks: list[Hunk]) -> dict[str, list[tuple[str, str]]]:
    """Per hunk, the OTHER hunks it shares a DISTINCTIVE NEW symbol with, plus that
    symbol: {hunk_id: [(other_hunk_id, symbol), ...]}. Symmetric def<->ref grounding
    — h links to other when one DEFINES a new-vocab symbol the other REFERENCES.
    Empty list for a hunk with no grounded sharing (the model wires it, if at all,
    from informal cues). Deterministic and fast (no LLM).

    AMBIENT FILTER (the precision lever): a symbol shared across MANY hunks is
    ambient (a shared util/field used everywhere) — wiring on it produces a hairball
    of 'environment noise wearing a link costume'. We drop symbols whose document
    frequency exceeds a third of the hunks (floor 5): distinctive types like
    `SupabaseBoosterRepository` (few hunks) survive; ubiquitous `member`/`boosters`
    do not. The model still prunes the rest by intent and adds informal edges."""
    dr = {h.id: _defs_refs(h.text) for h in hunks}
    new_vocab: set[str] = set().union(*(d for d, _ in dr.values())) if dr else set()
    # Document frequency over the union of defs+refs (how widely a symbol appears).
    doc_freq: dict[str, int] = {}
    for d, r in dr.values():
        for sym in (d | r) & new_vocab:
            doc_freq[sym] = doc_freq.get(sym, 0) + 1
    ambient_cut = max(5, len(hunks) // 3)
    distinctive = {s for s in new_vocab if doc_freq.get(s, 0) <= ambient_cut}
    out: dict[str, list[tuple[str, str]]] = {h.id: [] for h in hunks}
    ids = [h.id for h in hunks]
    for i, a in enumerate(ids):
        adef, aref = dr[a]
        for b in ids[i + 1:]:
            bdef, bref = dr[b]
            shared = distinctive & ((adef & bref) | (bdef & aref))
            for sym in sorted(shared):
                out[a].append((b, sym))
                out[b].append((a, sym))
    return out
