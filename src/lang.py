"""The LANGUAGE layer — syntactic extraction over diff text.

A cheap regex extractor: defined/referenced symbols, imports, and call/JSX
"subjects" pulled off a hunk's lines. It is intentionally the ONE place the
language-specific knowledge lives, so a tree-sitter/LSP backend can replace these
internals later behind the same signatures — every derived signal in
`symbol_edges` consumes these primitives, none re-implements them.

Known limits (the reason a real parser is the eventual upgrade): heavily JS/TS
shaped (JSX, `import {}`, `const`/arrow fns) with a few Kotlin/Ruby/SQL patterns;
weak on C/C++; no scope/semantics (a def's own name counts as a ref); can't tell
code from string/comment; no cross-file resolution (imports/re-exports/path
aliases). It is a FLOOR — informal couplings stay the LLM's job.
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
