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

import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from .lang import _added, _CALL_ROOT, _defs_refs, _IDENT, _JSX_TAG
from .parser import Hunk

# Bump when the serialized HunkFacts wire contract changes incompatibly. The VS Code
# (or any external) producer must emit this version; consumers tolerate missing keys.
FACTS_SCHEMA_VERSION = 1

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

    def to_dict(self) -> dict:
        """Serialize to the wire contract (sets -> sorted lists, deterministic). This is
        the exact shape an external producer (the VS Code extension) must emit per hunk."""
        return {
            "defines": sorted(self.defines), "references": sorted(self.references),
            "calls": sorted(self.calls), "enclosing": sorted(self.enclosing),
            "decisions": self.decisions, "implements": sorted(self.implements),
            "is_test": self.is_test, "is_sql": self.is_sql,
            "imports_only": self.imports_only, "type_decl_only": self.type_decl_only,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "HunkFacts":
        """Rebuild from the wire contract, tolerating missing keys (forward-compat:
        a producer that can't compute a fact omits it → empty = non-vote)."""
        return cls(
            defines=set(d.get("defines", [])), references=set(d.get("references", [])),
            calls=set(d.get("calls", [])), enclosing=set(d.get("enclosing", [])),
            decisions=int(d.get("decisions", 0)), implements=set(d.get("implements", [])),
            is_test=bool(d.get("is_test", False)), is_sql=bool(d.get("is_sql", False)),
            imports_only=bool(d.get("imports_only", False)),
            type_decl_only=bool(d.get("type_decl_only", False)),
        )


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


def facts_from_texts(raw_text: str, masked_text: str, file_path: str,
                     section_header: str) -> HunkFacts:
    """The shared facts assembly, given a hunk's RAW text and a COMMENT/STRING-MASKED
    version of the same text (same line structure). The regex producer masks with
    `_mask_code`; the tree-sitter producer masks with the AST. Keeping the assembly here
    means both producers compute facts IDENTICALLY from their masks — so any divergence
    is in the mask quality alone, which is exactly what we want to test.

    LOGIC-side facts (decisions / imports-only / type-decl / test / implements) use the
    MASKED text — an `if`/`describe(` inside a comment or string is not a decision/test.
    REFERENCE-side facts (defines / references / calls / enclosing) use the RAW text on
    purpose: an identifier named in a doc comment is a genuine weak wiring hint, and
    masking it measurably lost real seams."""
    m_added = _added(masked_text)
    m_sub = _substantive_lines(m_added)
    m_body = _body_lines(masked_text)

    decisions = sum(1 for ln in m_sub if _LOGIC.search(ln))
    imports_only = bool(m_sub) and all(_IMPORT_LINE.search(ln) for ln in m_sub)
    type_decl_only = (bool(m_sub) and decisions == 0
                      and bool(_TYPE_DECL.search(m_added)) and not _CODE_DEF.search(m_added))
    is_test = bool(_TEST_PATH.search(file_path or "")) or (
        bool(_TEST_MARKER.search(m_added)) and not _CODE_DEF.search(m_added))
    implements = set(_IMPLEMENTS.findall("\n".join(m_body)))

    defines, references = _defs_refs(raw_text)
    calls: set[str] = set()
    for ln in _body_lines(raw_text):
        calls.update(_CALL_ROOT.findall(ln))
        calls.update(_JSX_TAG.findall(ln))
    enclosing = set(_IDENT.findall(section_header or ""))

    return HunkFacts(
        defines=defines, references=references, calls=calls, enclosing=enclosing,
        decisions=decisions, implements=implements,
        is_test=is_test, is_sql=(file_path or "").endswith(".sql"),
        imports_only=imports_only, type_decl_only=type_decl_only,
    )


def extract(h: Hunk) -> HunkFacts:
    """Generic regex producer: raw diff text -> universal HunkFacts. Masks comments/
    strings best-effort with `_mask_code` (a stateful scanner, not a lexer)."""
    return facts_from_texts(h.text, _mask_code(h.text), h.file_path, h.section_header)


# --------------------------------------------------------------------------- file source
class FileSource(ABC):
    """Where a full-file (post-image) producer gets file content. Full-file context is
    what makes a parser exact (a multi-line string/comment starting before the hunk is
    only knowable from the whole file) and what makes tree-sitter and the VS Code AST
    provably equal — both parse the same file. VS Code supplies this natively; headless
    runs use RepoFileSource (working tree) or DictFileSource (fixtures/tests)."""

    @abstractmethod
    def read(self, path: str) -> str | None:
        ...


class RepoFileSource(FileSource):
    """Reads the post-image from the working tree under `repo`. For a diff being reviewed
    (uncommitted, or HEAD on a clean tree) the working-tree file IS the post-image; when
    it isn't (repo on another commit), the producer's alignment check falls back to regex."""

    def __init__(self, repo: str = "."):
        self.repo = repo

    def read(self, path: str) -> str | None:
        try:
            with open(os.path.join(self.repo, path), encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            return None


class DictFileSource(FileSource):
    """In-memory {path: content} — for fixtures and tests (line numbers align by
    construction, so equivalence assertions are exact)."""

    def __init__(self, files: dict[str, str]):
        self.files = dict(files)

    def read(self, path: str) -> str | None:
        return self.files.get(path)


# --------------------------------------------------------------------------- providers
class FactsProvider(ABC):
    """Strategy for turning hunks into the universal `HunkFacts` IR.

    Implement ONE subclass to plug in a new syntax source — regex (here), tree-sitter
    (headless / harness), the VS Code AST (the editor, full-file context), an LSP, … —
    and the classifier consumes the result without knowing or caring which produced it.

    The CORRECTNESS contract is defined purely at the output: two providers are
    equivalent iff they emit equal `HunkFacts` for the same hunks. That is what pins
    "tree-sitter must match the VS Code producer" as a concrete, testable assertion
    (see eval/facts_provider_test.assert_providers_equivalent) rather than a hope. Keep
    all provider-specific machinery (parsers, IPC, file access) BEHIND this boundary."""

    @abstractmethod
    def facts(self, hunks: list[Hunk]) -> dict[str, HunkFacts]:
        ...


class RegexFactsProvider(FactsProvider):
    """Generic, language-agnostic fallback (no parser). Works degraded on any language
    with C-style call syntax; the baseline every richer provider is compared against."""

    def facts(self, hunks: list[Hunk]) -> dict[str, HunkFacts]:
        return {h.id: extract(h) for h in hunks}


class ExternalFactsProvider(FactsProvider):
    """Adapts facts computed OUTSIDE Python to the same boundary — the one class you
    implement against for ANY external AST source.

    The source (e.g. the VS Code extension) walks its own AST with full-file context and
    emits the documented payload `{"version", "hunks": {id: HunkFacts.to_dict()}}`; this
    provider just deserializes it. Hunks ABSENT from the payload fall back to `fallback`
    (regex by default), so a source that resolves only some hunks degrades gracefully
    instead of dropping them — the honest-failure posture, at the facts layer."""

    def __init__(self, payload: dict | None, fallback: FactsProvider | None = None):
        self._by_id: dict = (payload or {}).get("hunks", {})
        self._fallback = fallback or RegexFactsProvider()

    def facts(self, hunks: list[Hunk]) -> dict[str, HunkFacts]:
        out: dict[str, HunkFacts] = {}
        missing: list[Hunk] = []
        for h in hunks:
            d = self._by_id.get(h.id)
            if d is None:
                missing.append(h)
            else:
                out[h.id] = HunkFacts.from_dict(d)
        if missing:
            out.update(self._fallback.facts(missing))
        return out


def facts_payload(hunks: list[Hunk], provider: FactsProvider | None = None) -> dict:
    """Serialize a provider's facts to the wire contract — for tooling, golden fixtures,
    and as the exact shape the VS Code/external side must mirror."""
    provider = provider or RegexFactsProvider()
    f = provider.facts(hunks)
    return {"version": FACTS_SCHEMA_VERSION,
            "hunks": {hid: hf.to_dict() for hid, hf in f.items()}}
