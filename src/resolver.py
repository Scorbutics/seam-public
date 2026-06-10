"""Resolver strategy — externalise module/symbol resolution so Seam stops reimplementing each stack.

`DeterministicResolver` = the offline FLOOR (relative + package.json names + tsconfig `paths`; no
server, no toolchain, instant). `LspResolver` (P1) drives a real language server (go-to-definition),
so `@/` aliases, node_modules, sys.path, #include, etc. are the SERVER's job — zero per-stack logic.

Resolution callers go through `import_scan._resolve`, which uses the process's active resolver (set
by the CLI's `--resolver`) or, by default, the deterministic floor. Direction: this is RESOLVE/down
only (go-to-definition); discovery/up stays the deterministic grep (find-references is monorepo-blind).
"""
from __future__ import annotations

import os
from typing import Protocol

from . import languages


class Resolver(Protocol):
    def resolve_module(self, repo: str, importing_file: str, source: str) -> str | None:
        """An import `source` as written in `importing_file` → a repo-relative file, or None."""
        ...


class DeterministicResolver:
    """The deterministic FLOOR — per-language offline resolution (relative / package / tsconfig alias),
    dispatched to the importing file's language provider (`src/languages/`). TS is implemented; a
    language with no floor resolves to None (resolution then relies on the LSP)."""

    def resolve_module(self, repo: str, importing_file: str, source: str) -> str | None:
        return languages.floor_resolve(os.path.expanduser(repo), importing_file, source)


def make_resolver(kind: str):
    """`det` → floor; `lsp` → LSP only; `auto` → LSP with deterministic fallback. Returns a Resolver
    or None (None ⇒ keep the default in-scan deterministic path, i.e. `det`). `lsp`/`auto` route
    through the persistent daemon (P4: warm servers reused across invocations; degrades to in-process
    LSP then the floor)."""
    if kind == "det":
        return None                                  # the scan's built-in deterministic path
    from .lsp.resolver import DaemonResolver          # lazy: only import the LSP stack when asked
    return DaemonResolver(fallback=(kind == "auto"))
