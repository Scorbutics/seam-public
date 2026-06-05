"""Tree-sitter facts producer — full-file, AST-grounded, behind the FactsProvider boundary.

Parses the post-image FULL FILE (via a FileSource) so comments, strings, and multi-line
constructs are identified EXACTLY — then masks comments/strings with the parse tree
(replacing the regex `_mask_code` best-effort), scopes to the hunk's changed new-side
lines, and reuses the shared `facts.facts_from_texts` assembly. Because both this and the
VS Code producer parse whole files and feed the same assembly, they are provably
comparable (eval/facts_provider_test.assert_providers_equivalent).

ROBUST FALLBACK: a hunk degrades to the regex producer when the file is unavailable, the
language is unsupported, parsing fails, or the file does NOT align with the diff (repo on
a different commit). We never trust a misaligned parse — honest failure at the facts layer.

Optional dependency: `tree_sitter_language_pack`. If absent, `available()` is False and
callers should use RegexFactsProvider. All tree-sitter specifics (including this binding's
quirk that node accessors are callables) are isolated to this module."""
from __future__ import annotations

import re

from .facts import FactsProvider, FileSource, HunkFacts, RegexFactsProvider, facts_from_texts
from .parser import Hunk

# file extension -> tree-sitter grammar name (tree_sitter_language_pack)
_LANG_BY_EXT = {
    ".py": "python", ".ts": "typescript", ".tsx": "tsx", ".js": "javascript",
    ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".c": "c", ".h": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".kt": "kotlin", ".kts": "kotlin",
    ".go": "go", ".rb": "ruby", ".java": "java", ".cs": "csharp", ".rs": "rust",
}

# A node whose KIND names a comment / string / char literal — its text is not code, so we
# blank it before any logic extraction. Universal across grammars (the names vary, but all
# contain one of these substrings).
def _is_comment_or_string(kind: str) -> bool:
    return "comment" in kind or "string" in kind or "char_literal" in kind


def available() -> bool:
    try:
        import tree_sitter_language_pack  # noqa: F401
        return True
    except Exception:
        return False


def _parser(lang: str):
    from tree_sitter_language_pack import get_parser
    return get_parser(lang)


def _ast_mask(content: str, lang: str) -> str | None:
    """Blank comment/string spans using the parse tree, preserving newlines (line numbers
    stay aligned with the diff). Returns None if parsing is unavailable/fails. NB: this
    binding exposes node accessors as CALLABLES (n.kind(), n.child_count(), …)."""
    try:
        root = _parser(lang).parse(content).root_node()
    except Exception:
        return None
    b = bytearray(content.encode("utf-8"))
    stack = [root]
    while stack:
        n = stack.pop()
        if _is_comment_or_string(n.kind()):
            for i in range(n.start_byte(), n.end_byte()):
                if b[i] != 0x0A:  # keep newlines
                    b[i] = 0x20
            continue              # don't descend into a masked node
        for i in range(n.child_count()):
            stack.append(n.child(i))
    return b.decode("utf-8", "replace")


_HUNK_HEADER = re.compile(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def _changed_newside(hunk: Hunk):
    """(start, end_exclusive, added) over NEW-side line numbers: the span the hunk covers
    and {lineno: added_line_text} for the '+' lines. None if the header is unparsable."""
    lines = hunk.text.splitlines()
    if not lines:
        return None
    m = _HUNK_HEADER.search(lines[0])
    if not m:
        return None
    start = int(m.group(1))
    count = int(m.group(2) or 1)
    added: dict[int, str] = {}
    ln = start
    for raw in lines[1:]:
        if raw.startswith("+") and not raw.startswith("+++"):
            added[ln] = raw[1:]
            ln += 1
        elif raw.startswith("-") and not raw.startswith("---"):
            pass  # removed line — no new-side number
        else:
            ln += 1  # context (or blank) — advances the new side
    return start, start + count, added


class TreeSitterFactsProvider(FactsProvider):
    """Full-file, AST-grounded provider. See module docstring."""

    def __init__(self, file_source: FileSource, fallback: FactsProvider | None = None,
                 min_alignment: float = 0.8):
        self._fs = file_source
        self._fallback = fallback or RegexFactsProvider()
        self._min_alignment = min_alignment

    def facts(self, hunks: list[Hunk]) -> dict[str, HunkFacts]:
        out: dict[str, HunkFacts] = {}
        missing: list[Hunk] = []
        for h in hunks:
            hf = self._one(h)
            if hf is None:
                missing.append(h)
            else:
                out[h.id] = hf
        if missing:
            out.update(self._fallback.facts(missing))  # degrade per hunk, never drop
        return out

    def _one(self, h: Hunk) -> HunkFacts | None:
        content = self._fs.read(h.file_path)
        if content is None:
            return None
        ext = h.file_path[h.file_path.rfind("."):].lower() if "." in h.file_path else ""
        lang = _LANG_BY_EXT.get(ext)
        if lang is None:
            return None
        masked = _ast_mask(content, lang)
        if masked is None:
            return None
        cn = _changed_newside(h)
        if cn is None:
            return None
        start, end, added = cn
        clines = content.splitlines()
        mlines = masked.splitlines()
        if end - 1 > len(clines) or len(clines) != len(mlines):
            return None  # span past EOF / mask desynced → don't trust it
        # Alignment guard: the diff's added lines must really be in this file (else the
        # working tree is on a different commit than the diff was cut from → fall back).
        ok = tot = 0
        for lineno, txt in added.items():
            if 1 <= lineno <= len(clines):
                tot += 1
                ok += clines[lineno - 1].strip() == txt.strip()
        if tot and ok / tot < self._min_alignment:
            return None

        def _build(lines: list[str]) -> str:
            out = ["@@ -0,0 +%d,%d @@" % (start, max(0, end - start))]
            for n in range(start, end):
                if 1 <= n <= len(lines):
                    out.append(("+" if n in added else " ") + lines[n - 1])
            return "\n".join(out)

        return facts_from_texts(_build(clines), _build(mlines), h.file_path, h.section_header)
