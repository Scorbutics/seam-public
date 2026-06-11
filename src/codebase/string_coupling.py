"""Tier-2 of the edge ladder: STRING-DISPATCH couplings → RESOLVED_PARTIAL.

The ladder (per coupling): deterministic binding (import/LSP) = RESOLVED_FULL → THIS (a string literal,
validated on BOTH ends) = RESOLVED_PARTIAL → LLM discovery = SUGGESTED → else a boundary blind spot.

This tier covers couplings carried by a STRING, not a symbol — `x.invoke("process-payment")` reaching
`**/process-payment/index.ts`. It is framework-AGNOSTIC: this module owns only the GENERIC logic (find a
distinctive string in a call → match a UNIQUE existing module entry). The per-language CONVENTIONS — what
filename marks a module entry (`index.*` vs `__init__.py`) and where the entrypoint is inside it — live in
the providers (`languages/<lang>.py`), reached via `languages.is_module_entry` / `entrypoint_line`.
PRECISION comes from validating the OTHER end (a unique existing entry), not from guessing: a distinctive
dispatch string with no unique entry is NOT asserted (ambiguous → blind spot; unmatched → tier 3, the LLM).
"""
from __future__ import annotations

import os
import re

from ..core.resolve import languages
from .atoms import _Ctx, _CALL, available, lang_for

_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{2,}$")   # a name-like literal (no spaces/paths/urls)
_MULTISEGMENT = re.compile(r"[-_]")                      # kebab/snake = the distinctiveness signal
_ENTRY_CACHE: dict[str, dict[str, list[str]]] = {}


def module_entry_index(repo: str, skip_dirs) -> dict[str, list[str]]:
    """{directory-basename → [repo-relative module-entry paths]} — every dir that holds a module ENTRY
    (per each language's convention, via `languages.is_module_entry`), i.e. the 'endpoint-shaped'
    targets a dispatch string can name. Cached per repo (like `_pkg_map`)."""
    if repo in _ENTRY_CACHE:
        return _ENTRY_CACHE[repo]
    idx: dict[str, list[str]] = {}
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        entry = next((f for f in files if languages.is_module_entry(f)), None)
        if entry:
            idx.setdefault(os.path.basename(root), []).append(os.path.relpath(os.path.join(root, entry), repo))
    _ENTRY_CACHE[repo] = idx
    return idx


def entry_line(repo: str, rel_path: str) -> int:
    """MAIN entrypoint line INSIDE a module entry — so a string-dispatch node opens the HANDLER, not
    line 0 (the docstring). Parses the file here; the per-language heuristic lives in the provider
    (`languages.entrypoint_line`). 0 if it can't parse or the language has no heuristic."""
    if not available():
        return 0
    try:
        text = open(os.path.join(repo, rel_path), encoding="utf-8", errors="ignore").read()
        ctx = _Ctx(text, lang_for(rel_path) or "")
    except Exception:
        return 0
    return languages.entrypoint_line(rel_path, ctx)


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
    edges: list[tuple[str, str, int]] = []
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
                edges.append((name, hits[0], s))           # s = the dispatch CALL line (for the chain back-link)
            elif len(hits) > 1:
                ambiguous.append((name, hits))
    return edges, ambiguous
