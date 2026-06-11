"""Blast radius — who, OUTSIDE the diff, consumes a symbol the diff CHANGES.

The diff alone shows the changed lines; this reads them in the context of the real repo: for
each distinctive symbol a hunk DEFINES, find the files elsewhere in the repo that import it, and
classify each by the same resolved/suggested honesty split the codebase scan uses. That answers
"what's the impact of this change" — the reviewer-facing context the hunks can't carry alone.

Deterministic by default (the offline floor); honours the process-wide resolver (--resolver lsp|
auto) installed via core.resolve.consumers.set_resolver. ONE repo walk for the union of all
defined symbols (not one per symbol) — the monorepo perf guard.

Architecture: diff mode reaches resolution only through src.core.resolve (never src.codebase).
"""
from __future__ import annotations

import os

from ..core.resolve import languages
from ..core.resolve.consumers import _resolve_import
from ..core.resolve.languages.base import SKIP_DIRS as _SKIP_DIRS
from ..core.resolve.languages import SOURCE_EXTS as _EXTS
from .classifier_det import _subject_ok
from .lang import _defs_refs
from .parser import Hunk

# Don't scan blast radius for an absurd number of symbols (a giant generated diff) — a soft cap
# so one walk stays bounded; the walk itself is O(repo files) regardless.
_MAX_SYMBOLS = 200


def consumers_for(hunks: list[Hunk], repo: str | None) -> dict[str, list[dict]]:
    """{hunk_id: [{file, symbol, status}]} — for every DISTINCTIVE symbol a hunk defines, the
    files OUTSIDE the diff that import it. `status` is "resolved" (the import path resolves to the
    changed file — a real consumer) or "suggested" (unresolvable but basename-matching — a blind
    spot, never asserted). Empty dict when `repo` is absent or no distinctive symbol is defined."""
    if not repo:
        return {}
    repo = os.path.expanduser(repo)
    # symbol → [(changed-file repo-relative-normpath, hunk_id)] for the distinctive defines.
    owners: dict[str, list[tuple[str, str]]] = {}
    changed: set[str] = set()
    for h in hunks:
        if h.role == "noise":
            continue
        changed.add(os.path.normpath(h.file_path))
        for s in _defs_refs(h.text)[0]:
            if _subject_ok(s):
                owners.setdefault(s, []).append((os.path.normpath(h.file_path), h.id))
    if not owners:
        return {}
    if len(owners) > _MAX_SYMBOLS:                       # soft cap — keep the largest-named first
        owners = dict(sorted(owners.items(), key=lambda kv: -len(kv[0]))[:_MAX_SYMBOLS])
    union_syms = set(owners)

    out: dict[str, list[dict]] = {h.id: [] for h in hunks}
    seen: set[tuple[str, str, str]] = set()             # (hunk_id, consumer_file, symbol) dedup
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_EXTS):
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, repo)
            if os.path.normpath(rel) in changed:         # a changed file is part of the diff, not a consumer
                continue
            try:
                text = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if not any(s in text for s in union_syms):
                continue
            for ref in languages.parse_imports(rel, text):
                if ref.name not in union_syms:
                    continue
                target = _resolve_import(repo, rel, ref)
                tnorm = os.path.normpath(target[0]) if target and target[0] else None
                for anchor_norm, hid in owners[ref.name]:
                    key = (hid, rel, ref.name)
                    if key in seen:
                        continue
                    if tnorm is not None:
                        if tnorm == anchor_norm:         # import resolves to the changed file → real consumer
                            out[hid].append({"file": rel, "symbol": ref.name, "status": "resolved"})
                            seen.add(key)
                        # else: resolves to a DIFFERENT same-named symbol → not our consumer
                    elif ref.source and ref.source.rstrip("/").split("/")[-1] == \
                            os.path.splitext(os.path.basename(anchor_norm))[0]:
                        out[hid].append({"file": rel, "symbol": ref.name, "status": "suggested"})
                        seen.add(key)
    return {hid: cs for hid, cs in out.items() if cs}
