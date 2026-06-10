"""Python — LSP via pyright (no deterministic floor yet; resolution relies on the server). The
deterministic SCAN for Python (bare `from .x import` discovery, not quoted module strings) is the
P2 cross-language-scan work, not here."""
from __future__ import annotations

from .base import LanguageProvider, ServerSpec, bun_x

PROVIDER = LanguageProvider(
    name="python",
    extensions=(".py", ".pyi"),
    resolve=None,
    lsp=ServerSpec(
        language="python",
        command=bun_x("pyright-langserver", "--stdio"),
        language_id="python",
        root_markers=("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"),
        status="scaffold",
        notes="Phase 2. pyright via bun x; venv detection (python.venvPath/pythonPath).",
    ),
)
