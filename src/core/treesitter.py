"""Tree-sitter PARSING substrate — the cross-language primitive shared by both modes (diff facts via
`facts_treesitter`, codebase facts via `atoms`). Just: ext→grammar, a parser, and availability. No
diff/codebase knowledge. Optional dep `tree_sitter_language_pack`; absent ⇒ `available()` is False."""
from __future__ import annotations

# file extension -> tree-sitter grammar name (tree_sitter_language_pack)
_LANG_BY_EXT = {
    ".py": "python", ".ts": "typescript", ".tsx": "tsx", ".js": "javascript",
    ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".c": "c", ".h": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".kt": "kotlin", ".kts": "kotlin",
    ".go": "go", ".rb": "ruby", ".java": "java", ".cs": "csharp", ".rs": "rust",
}


def _is_comment_or_string(kind: str) -> bool:
    """A node whose KIND names a comment / string / char literal — its text is not code."""
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
