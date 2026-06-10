"""Python — import discovery (bare `from .x import`, not quoted module strings) + LSP via pyright
(no deterministic floor; resolution relies on the server's go-to-definition)."""
from __future__ import annotations

import re

from .base import LanguageProvider, ServerSpec, bun_x

_FROM_RE = re.compile(r"^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$")
_IMPORT_RE = re.compile(r"^\s*import\s+(.+)$")


def parse_imports(text: str) -> list[tuple[str, int, int]]:
    """Python imports → [(imported name, 0-based line, 0-based col)] — the position of each name so
    the resolver can go-to-definition on it. `from M import a, b` → a, b; `import os` → os (an
    external/stdlib — the resolver returns None). Single-line forms (parenthesised multi-line: TODO)."""
    out: list[tuple[str, int, int]] = []
    for i, line in enumerate(text.splitlines()):
        m = _FROM_RE.match(line)
        if m:
            for seg in m.group(2).split("#")[0].split(","):
                orig = seg.strip().strip("()").split(" as ")[0].strip()
                if orig and orig != "*":
                    col = line.find(orig, m.start(2))
                    out.append((orig, i, col if col >= 0 else m.start(2)))
            continue
        m = _IMPORT_RE.match(line)
        if m and not line.lstrip().startswith("from"):
            for seg in m.group(1).split("#")[0].split(","):
                orig = seg.strip().split(" as ")[0].strip().split(".")[0]
                if orig:
                    out.append((orig, i, line.find(orig)))
    return out


# A Python PACKAGE entry is `__init__.py` (NOT `index.py` — that's the JS convention).
_MODULE_ENTRY = re.compile(r"^__init__\.py$")


def _entrypoint(ctx) -> int | None:
    """Main entry INSIDE a Python module: `if __name__ == '__main__':` → else a top-level CALL
    (`main()` / `app.run()`) → else the first top-level statement that isn't a comment / import."""
    top = ctx.children(ctx.root)
    main = next((n for n in top if n.kind() == "if_statement" and "__main__" in ctx.text(n)[:80]), None)
    if main is not None:
        return ctx.span(main)[0]
    call = next((n for n in top if n.kind() == "expression_statement"
                 and ctx.children(n) and "call" in ctx.children(n)[0].kind()), None)
    if call is not None:
        return ctx.span(call)[0]
    real = next((n for n in top if n.kind() not in
                 ("comment", "import_statement", "import_from_statement", "future_import_statement")), None)
    return ctx.span(real)[0] if real is not None else None


PROVIDER = LanguageProvider(
    name="python",
    extensions=(".py", ".pyi"),
    resolve=None,
    module_entry=_MODULE_ENTRY,
    entrypoint=_entrypoint,
    lsp=ServerSpec(
        language="python",
        command=bun_x("--package", "pyright", "pyright-langserver", "--stdio"),
        language_id="python",
        root_markers=("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"),
        status="scaffold",
        notes="Phase 2. pyright via bun x; venv detection (python.venvPath/pythonPath).",
    ),
)


def imports(text: str) -> list:
    """Python imports → [ImportRef(name, name, line, col, source=None)] — `source` is None so the
    generic scan resolves each by SYMBOL position (pyright go-to-def), not a module path."""
    from .base import ImportRef
    return [ImportRef(name, name, line, col, None) for name, line, col in parse_imports(text)]


PROVIDER.imports = imports
