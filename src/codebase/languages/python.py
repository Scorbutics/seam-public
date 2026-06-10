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


PROVIDER = LanguageProvider(
    name="python",
    extensions=(".py", ".pyi"),
    resolve=None,
    lsp=ServerSpec(
        language="python",
        command=bun_x("--package", "pyright", "pyright-langserver", "--stdio"),
        language_id="python",
        root_markers=("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"),
        status="scaffold",
        notes="Phase 2. pyright via bun x; venv detection (python.venvPath/pythonPath).",
    ),
)
