"""Language-provider substrate. Each language lives in its own `src/languages/<name>.py` and exposes a
`PROVIDER` (a `LanguageProvider`): its file extensions, an optional deterministic FLOOR resolver
(relative/alias/package resolution that works offline), and an optional LSP `ServerSpec`. The generic
core (import_scan, resolver, lsp/*) is language-agnostic and only ever touches a provider through
`src.languages` — so adding a language is adding a file, not editing the core."""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass

# Directories every repo walk skips — generic (not language-specific), shared by scan + pkg-map.
SKIP_DIRS = {"node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv", "out",
             "target", "vendor", ".gradle", "__pycache__"}


@dataclass
class ImportRef:
    """One imported symbol, the uniform unit the generic scan consumes (so it's language-agnostic).
    `source` set ⇒ resolve the MODULE path (TS: `from "x" import …`); `source` None ⇒ resolve the
    SYMBOL at (line, col) via the LSP (Python: `from .x import …`)."""
    name: str                # the imported symbol's ORIGINAL name (matched against the anchor)
    local: str               # its local binding (after `as`) — the consumer node label
    line: int                # 0-based line of the import (symbol-position resolution)
    col: int
    source: str | None       # the module string, or None when there's no quoted module to resolve


@dataclass
class ServerSpec:
    """How to launch + drive a language's LSP server. Pure config — no resolution logic."""
    language: str
    command: object                     # (repo) -> argv list, or None if the server is unobtainable
    language_id: object                 # str, or (file)->str when a stack has per-file ids (tsx/jsx)
    root_markers: tuple[str, ...] = ()
    init_options: object = None         # (repo)->dict, or None
    status: str = "scaffold"            # full | impl | scaffold
    notes: str = ""


@dataclass
class LanguageProvider:
    name: str
    extensions: tuple[str, ...]
    # deterministic FLOOR resolver: (repo, importing_file, source) -> repo-relative file | None.
    # None ⇒ this language has no offline floor; resolution relies on the LSP (or stays unresolved).
    resolve: object = None
    lsp: ServerSpec | None = None
    # MODULE-ENTRY convention: a compiled regex on a basename that marks a module entry — the
    # 'endpoint-shaped' target a string-dispatch can name (TS/JS `index.*`, Python `__init__.py`).
    # None ⇒ no such convention. Consumed by string_coupling (tier 2 of the edge ladder).
    module_entry: object = None
    # callable(ctx) -> int | None: the MAIN-entry line INSIDE a module entry (so a dispatch node opens
    # the handler, not line 0). Language-specific AST heuristic; `ctx` is a tree-sitter `_Ctx` (duck).
    entrypoint: object = None
    # callable(text) -> list[ImportRef]: the file's import statements, the uniform unit the generic
    # codebase SCAN consumes (replaces per-language `_IMPORT_RE` loops). None ⇒ no scan support yet.
    imports: object = None


def bun_x(*pkg_args: str):
    """An npm-distributed server, fetched/run via bun (no global install). None if bun is absent."""
    def cmd(repo: str):
        bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
        return [bun, "x", *pkg_args] if os.path.exists(bun) else None
    return cmd


def system(binary: str, *rest: str):
    """A server expected on PATH (system install). None if absent → that language degrades to floor."""
    def cmd(repo: str):
        b = shutil.which(binary)
        return [b, *rest] if b else None
    return cmd
