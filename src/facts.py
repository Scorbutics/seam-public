"""Language facts — the intermediate representation the classifier reasons over.

The deterministic classifier needs only a SMALL, universal vocabulary that every
imperative language expresses somehow: what a hunk DEFINES, what it REFERENCES /
CALLS, the scope it edits (ENCLOSING), how much it DECIDES (branch/return density),
whether it IMPLEMENTS a contract, and whether it is a TEST. This module is the ONE
place that turns raw diff text into those facts — the classifier then contains zero
regex and zero language knowledge.

`extract` is the GENERIC producer: regex-based, and degrades gracefully on any
language with C-style calls (the universal signal). A language with its own producer
(or a future tree-sitter backend) would emit the SAME `HunkFacts` more precisely —
the classifier is unchanged. Unknown facts are EMPTY, never guessed: an empty signal
means "no information", which the classifier treats as a non-vote, so an unmodelled
language degrades rather than misclassifies (e.g. Go has no `implements` keyword →
`implements` stays empty → the adapter rule simply doesn't fire).

This sits one level above `lang` (low-level symbol extraction): `extract` composes
`lang`'s primitives and adds the role-relevant surface patterns (logic, imports,
type decls, tests, implements).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .lang import _added, _CALL_ROOT, _defs_refs, _IDENT, _JSX_TAG
from .parser import Hunk

# --- language surface patterns (the swappable, language-specific part) -------
# Behavioral logic — branches, returns, throws, async edges, boolean/comparison
# operators. C-family today (a per-language producer would add `elif`/`unless`/…).
_LOGIC = re.compile(
    r"\b(if|else|for|while|switch|case|return|throw|try|catch|await|yield)\b"
    r"|&&|\|\||[!=<>]=|\?\."
)
# Import / re-export line — pure wiring-in, no logic.
_IMPORT_LINE = re.compile(
    r"^\s*(import\b|export\b.*\bfrom\b|from\b.+\bimport\b|export\s*\{)"
)
# Type-level declarations (ambient): interface / type alias / enum.
_TYPE_DECL = re.compile(r"\b(interface|type|enum)\s+[A-Za-z_]")
# Code definitions (behavioral): function / class / def / fun, or an arrow-fn body.
_CODE_DEF = re.compile(r"\b(function|class|def|fun)\b|=>")
# Test-file path shapes across common ecosystems (the high-precision test signal).
_TEST_PATH = re.compile(
    r"(^|/)(__tests__|tests?|spec)/"
    r"|[._/](test|spec)\.[a-z0-9]+$"
    r"|(^|/)test_[^/]+\.py$"
    r"|_test\.(go|py|ts|js)$"
    r"|_spec\.rb$"
    r"|test[a-z0-9_]*\.(kt|java)$",
    re.IGNORECASE,
)
# Secondary, content-based test markers (used only when the path is inconclusive).
_TEST_MARKER = re.compile(
    r"\b(describe|it|expect|test)\s*\(|@Test\b|\bself\.assert|\bunittest\b|\bpytest\b"
)
# A class implementing an interface — the adapter relation. `implements` is a
# Java/TS/C#/PHP keyword; Go (structural), Rust (`impl..for`), C++ (`: public`) say
# it differently, so this stays empty there (a non-vote, not a wrong vote).
_IMPLEMENTS = re.compile(r"\bimplements\s+([A-Z]\w*)")


@dataclass
class HunkFacts:
    """The universal facts about one hunk. New fields are additive — producers fill
    what they can, the classifier reads what it needs; absence is a non-vote."""
    defines: set[str] = field(default_factory=set)      # symbols the hunk defines
    references: set[str] = field(default_factory=set)    # symbols it references
    calls: set[str] = field(default_factory=set)         # call/JSX subjects on its lines
    enclosing: set[str] = field(default_factory=set)     # idents in the @@ scope header
    decisions: int = 0                                   # logic-magnitude (branch/return…)
    implements: set[str] = field(default_factory=set)    # interfaces implemented (adapter)
    is_test: bool = False
    is_sql: bool = False
    imports_only: bool = False                           # whole body is imports
    type_decl_only: bool = False                         # pure type/interface/enum, no logic


def _mask_code(text: str) -> str:
    """Best-effort removal of COMMENTS and STRING CONTENTS before any regex runs —
    so `if`/`return`/`foo()` *inside* a comment or string literal don't masquerade as
    logic, calls, or symbols (measured: C comment blocks leak prose into the facts and
    inflate decisions/wiring). A small stateful scanner, NOT a lexer: it handles C-family
    line/block comments (`//`, `/* */`) and `" ' \\`` strings with backslash escapes,
    preserving line structure and the leading diff marker. It deliberately does NOT touch
    `#` (preprocessor in C, private field in JS) or `--` (decrement vs SQL comment) — those
    cross-language ambiguities are exactly why the real fix is an AST producer (tree-sitter
    / VS Code), which this masker is a stopgap for. Unhandled languages just keep their
    comments; they don't get corrupted."""
    out_lines: list[str] = []
    in_block = False
    for raw in text.splitlines():
        marker = raw[:1] if raw[:1] in "+- " else ""
        s = raw[len(marker):]
        masked: list[str] = []
        i, n, in_str = 0, len(s), None
        while i < n:
            c, two = s[i], s[i:i + 2]
            if in_block:
                if two == "*/":
                    in_block = False
                    i += 2
                    continue
                i += 1
                continue
            if in_str:
                if c == "\\":
                    i += 2
                    continue
                masked.append(c if c == in_str else " ")
                if c == in_str:
                    in_str = None
                i += 1
                continue
            if two == "/*":
                in_block = True
                i += 2
                continue
            if two == "//":
                break  # rest of line is a comment
            if c in "\"'`":
                in_str = c
                masked.append(c)
                i += 1
                continue
            masked.append(c)
            i += 1
        out_lines.append(marker + "".join(masked))
    return "\n".join(out_lines)


def _substantive_lines(added: str) -> list[str]:
    """Added code lines that carry meaning — drop blanks, comments, lone braces/punct."""
    out = []
    for raw in added.splitlines():
        s = raw.strip()
        if not s or s.startswith(("//", "#", "/*", "*", "*/")):
            continue
        if all(c in "{}()[];," for c in s):
            continue
        out.append(s)
    return out


def _body_lines(text: str) -> list[str]:
    """The hunk's changed/context lines (after the @@ header), +/- marker stripped."""
    return [ln[1:] if ln[:1] in "+- " else ln for ln in text.splitlines()[1:]]


def extract(h: Hunk) -> HunkFacts:
    """Generic regex producer: raw diff text -> universal HunkFacts.

    Comments/strings are masked for the LOGIC-side facts (decisions / imports-only /
    type-decl / test / implements): an `if` or `describe(` inside a comment or string is
    NOT a decision or a test — masking removes that false signal (measured: lifts role
    precision). But the REFERENCE-side facts (defines / references / calls / enclosing)
    are left UNMASKED on purpose: an identifier named in a doc comment is a genuine weak
    wiring hint (`// wraps the DisplayWindow`), and masking it measurably *lost* real
    seams. A regex producer can't have it both ways cleanly — separating which symbol
    truly couples from which is merely named is exactly what an AST producer buys us."""
    masked = _mask_code(h.text)               # logic-side: comments/strings removed
    m_added = _added(masked)
    m_sub = _substantive_lines(m_added)
    m_body = _body_lines(masked)

    decisions = sum(1 for ln in m_sub if _LOGIC.search(ln))
    imports_only = bool(m_sub) and all(_IMPORT_LINE.search(ln) for ln in m_sub)
    type_decl_only = (bool(m_sub) and decisions == 0
                      and bool(_TYPE_DECL.search(m_added)) and not _CODE_DEF.search(m_added))
    is_test = bool(_TEST_PATH.search(h.file_path or "")) or (
        bool(_TEST_MARKER.search(m_added)) and not _CODE_DEF.search(m_added))
    implements = set(_IMPLEMENTS.findall("\n".join(m_body)))

    defines, references = _defs_refs(h.text)   # reference-side: unmasked (doc-comment hints)
    calls: set[str] = set()
    for ln in _body_lines(h.text):
        calls.update(_CALL_ROOT.findall(ln))
        calls.update(_JSX_TAG.findall(ln))
    enclosing = set(_IDENT.findall(h.section_header or ""))

    return HunkFacts(
        defines=defines, references=references, calls=calls, enclosing=enclosing,
        decisions=decisions, implements=implements,
        is_test=is_test, is_sql=(h.file_path or "").endswith(".sql"),
        imports_only=imports_only, type_decl_only=type_decl_only,
    )
