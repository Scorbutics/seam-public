"""ResolvedFactsProvider — enrich a base provider's HunkFacts with codebase-resolved references.

The diff text alone says a hunk REFERENCES a symbol it doesn't define; this asks the real repo
WHERE that symbol lives. For each (symbol, source) the hunk imports-and-uses but defines nowhere
in the diff (`symbol_edges.external_refs`), it resolves the import `source` against the repo via the
active resolver (the deterministic floor by default; LSP under --resolver lsp|auto) and records the
target file on `HunkFacts.resolved_refs`. The classifier then uses those — purely ADDITIVELY — to
wire a hunk to an in-diff core it reaches by a real import (not just by a shared raw symbol name) and
to recover a core/link call the in-diff-only grounding missed.

A decorator over any base FactsProvider: base facts are untouched; only `resolved_refs` is added.
Degrades to the base exactly when `repo` is absent, the language has no floor, or nothing resolves.
Architecture: reaches resolution only through src.core.resolve (never src.codebase).
"""
from __future__ import annotations

import os

from ..core.resolve.consumers import _resolve
from .facts import FactsProvider, HunkFacts
from .parser import Hunk
from .symbol_edges import external_refs


class ResolvedFactsProvider(FactsProvider):
    """Wrap `base`; for each hunk, resolve its out-of-diff references against `repo` and attach
    them as `HunkFacts.resolved_refs` ({symbol: repo-relative target file})."""

    def __init__(self, base: FactsProvider, repo: str | None):
        self._base = base
        self._repo = os.path.expanduser(repo) if repo else None

    def facts(self, hunks: list[Hunk]) -> dict[str, HunkFacts]:
        out = self._base.facts(hunks)
        if not self._repo:
            return out
        refs = external_refs(hunks)                       # {hid: [{"symbol","source"}]}
        for h in hunks:
            hf = out.get(h.id)
            if hf is None:
                continue
            resolved: dict[str, str] = {}
            for r in refs.get(h.id, []):
                tgt = _resolve(self._repo, h.file_path, r["source"])
                if tgt:
                    resolved[r["symbol"]] = os.path.normpath(tgt)
            if resolved:
                hf.resolved_refs = resolved
        return out
