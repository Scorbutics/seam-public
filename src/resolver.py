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

from . import import_scan


class Resolver(Protocol):
    def resolve_module(self, repo: str, importing_file: str, source: str) -> str | None:
        """An import `source` as written in `importing_file` → a repo-relative file, or None."""
        ...


class DeterministicResolver:
    """The floor — the current relative / package / tsconfig-`paths` logic. Caches `_pkg_map` per repo."""

    def __init__(self) -> None:
        self._pkgs: dict[str, dict[str, str]] = {}

    def _pkg(self, repo: str) -> dict[str, str]:
        if repo not in self._pkgs:
            self._pkgs[repo] = import_scan._pkg_map(repo)
        return self._pkgs[repo]

    def resolve_module(self, repo: str, importing_file: str, source: str) -> str | None:
        repo = os.path.expanduser(repo)
        return import_scan.resolve_module(repo, importing_file, source, self._pkg(repo))


def make_resolver(kind: str):
    """`det` → floor; `lsp` → LSP only; `auto` → LSP with deterministic fallback. Returns a Resolver
    or None (None ⇒ keep the default in-scan deterministic path, i.e. `det`)."""
    if kind == "det":
        return None                                  # the scan's built-in deterministic path
    from .lsp.resolver import LspResolver            # lazy: only import the LSP stack when asked
    return LspResolver(fallback=(kind == "auto"))
