"""Tier-2 of the edge ladder: STRING-DISPATCH couplings → RESOLVED_PARTIAL.

The ladder (per coupling): deterministic binding (import/LSP) = RESOLVED_FULL → THIS (a string literal,
validated on BOTH ends) = RESOLVED_PARTIAL → LLM discovery = SUGGESTED → else a boundary blind spot.

This tier covers couplings carried by a STRING, not a symbol — `x.invoke("process-payment")` reaching
`**/process-payment/index.ts`. It is framework-AGNOSTIC: the only "convention" it knows is that an
`index.*` file marks a module ENTRY (universal), and that a multi-segment name (kebab/snake) is
distinctive. PRECISION comes from validating the OTHER end — the string must name a UNIQUE existing
module entry — not from guessing. A distinctive dispatch string with no unique entry is NOT asserted:
an ambiguous one becomes a blind spot (candidates); an unmatched one is left to tier 3 (the LLM).
"""
from __future__ import annotations

import os
import re

from .atoms import _CALL, _Ctx

_INDEX_RE = re.compile(r"^index\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py)$")
_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{2,}$")   # a name-like literal (no spaces/paths/urls)
_MULTISEGMENT = re.compile(r"[-_]")                      # kebab/snake = the distinctiveness signal
_ENTRY_CACHE: dict[str, dict[str, list[str]]] = {}


def module_entry_index(repo: str, skip_dirs) -> dict[str, list[str]]:
    """{directory-basename → [repo-relative index.* paths]} — every dir that holds an `index.*`, i.e.
    the 'endpoint-shaped' targets a dispatch string can name. Cached per repo (like `_pkg_map`).
    `index.*` is the one universal signal that a directory is a thing you ENTER (a module/route/fn)."""
    if repo in _ENTRY_CACHE:
        return _ENTRY_CACHE[repo]
    idx: dict[str, list[str]] = {}
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        entry = next((f for f in files if _INDEX_RE.match(f)), None)
        if entry:
            idx.setdefault(os.path.basename(root), []).append(os.path.relpath(os.path.join(root, entry), repo))
    _ENTRY_CACHE[repo] = idx
    return idx


def _call_string_args(ctx: _Ctx, call) -> list[str]:
    """Distinctive name-like string literals appearing as arguments inside a call node."""
    out: list[str] = []
    for s in ctx.collect(call, lambda k: "string" in k and "interpolation" not in k):
        t = ctx.text(s).strip("\"'`")
        if _NAME_RE.match(t) and _MULTISEGMENT.search(t):
            out.append(t)
    return out


def detect(ctx: _Ctx, lo: int, hi: int, index: dict[str, list[str]], anchor_file: str):
    """Scan calls within the anchor's body [lo, hi] for a distinctive string naming a module entry.
    Returns (edges, ambiguous): a UNIQUE existing entry → `(name, path)` (RESOLVED_PARTIAL); two-or-more
    → `(name, [paths])` (a blind spot — candidates, never an asserted edge)."""
    anchor_dir = os.path.dirname(anchor_file)
    edges: list[tuple[str, str]] = []
    ambiguous: list[tuple[str, list[str]]] = []
    seen: set[str] = set()
    for call in ctx.collect(ctx.root, lambda k: k in _CALL):
        s, _ = ctx.span(call)
        if s < lo or s > hi:
            continue
        for name in _call_string_args(ctx, call):
            if name in seen:
                continue
            seen.add(name)
            # validate the OTHER end: a unique module entry by that name, not the anchor's own dir
            hits = [p for p in index.get(name, []) if os.path.dirname(p) != anchor_dir]
            if len(hits) == 1:
                edges.append((name, hits[0]))
            elif len(hits) > 1:
                ambiguous.append((name, hits))
    return edges, ambiguous
