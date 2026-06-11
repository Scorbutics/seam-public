"""Consumer discovery — the DETERMINISTIC front that finds who imports a symbol, plus the
resolver-injection seam every resolution call goes through. Promoted from import_scan.py so
diff mode can ask "who, outside this diff, consumes a changed symbol" (blast radius) without
importing src/codebase (architecture rule). The graph-building machinery (tree-sitter atoms,
class/method attribution, depth-2 ripple) stays in src/codebase/import_scan.py — this module
is just the thin, atom-free cone it (and now diff mode) shares.

THE INVARIANT (plan §1): an edge is stamped RESOLVED only when the import's module path
RESOLVES to the anchor file. A name match whose module does NOT resolve is recorded as a
SUGGESTED blindspot — never a resolved edge. So completeness is never over-claimed.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

from . import languages
from .languages.base import SKIP_DIRS as _SKIP_DIRS         # shared walk skip-dirs (generic)
from .languages import SOURCE_EXTS as _EXTS   # walk extensions: union of ALL providers

# A consumer in a test file is VERIFICATION (the `test` role), not an in-footprint link or a
# boundary intent — so it's separated out (mirrors resolver.ts TEST_PATH). Covers `*.test.ts` /
# `*.spec.ts` and `tests/` `__tests__/` `spec/` dirs.
_TEST_RE = re.compile(r"(\.(test|spec)\.[a-z]+$)|((^|/)(tests?|__tests__|spec)/)", re.I)


def _kind_for(file: str, kind: str) -> str:
    """A consumer node's kind, overriding to 'test' for test files (→ the `test` role)."""
    return "test" if _TEST_RE.search(file.replace("\\", "/")) else kind


# --------------------------------------------------------------------------- resolver injection
# The scan resolves imports through `_resolve`, which uses the process's ACTIVE resolver (set by the
# CLI's --resolver, e.g. an LspResolver) or, by default, the deterministic floor. This is the
# one seam where stack-specific resolution can be swapped for a real language server (see resolver.py).
_ACTIVE_RESOLVER = None


def set_resolver(r) -> None:
    """Install the process-wide resolver (None ⇒ the deterministic floor). Set once by the CLI."""
    global _ACTIVE_RESOLVER
    _ACTIVE_RESOLVER = r


def _resolve(repo: str, importing_file: str, source: str) -> str | None:
    """A MODULE source → repo-relative file: the active resolver, else the per-language deterministic
    floor (`languages.floor_resolve` — dispatches to the importing file's provider)."""
    if _ACTIVE_RESOLVER is not None:
        return _ACTIVE_RESOLVER.resolve_module(repo, importing_file, source)
    return languages.floor_resolve(repo, importing_file, source)


def _resolve_import(repo: str, importing_file: str, ref) -> tuple | None:
    """An `ImportRef` → (repo-relative target file, def line | None), or None. A source-string import
    (TS) resolves the MODULE path (its def line is found later via tree-sitter); a source-less import
    (Python) resolves the SYMBOL at (line, col) via the LSP, which already yields (file, line)."""
    if ref.source is not None:
        f = _resolve(repo, importing_file, ref.source)
        return (f, None) if f else None
    r = _ACTIVE_RESOLVER
    if r is not None and hasattr(r, "resolve_symbol"):
        return r.resolve_symbol(repo, importing_file, ref.line, ref.col)   # (file, line) or None
    return None


# --------------------------------------------------------------------------- named-import scan
@dataclass
class Consumer:
    file: str                  # repo-relative
    local: str                 # local binding name (after `as`)
    source: str                # import source as written
    status: str                # "resolved" (module → anchor file) | "suggested" (basename only)


def scan_consumers(repo: str, anchor_file: str, symbol: str) -> list[Consumer]:
    """Files importing `symbol`, classified by how confidently the module is the anchor's:

      - "resolved"  — the import path resolves to `anchor_file` (RESOLVED edge).
      - "suggested" — the path is UNRESOLVABLE (alias we can't follow) but shares the anchor's
                      basename ⇒ might be ours, can't confirm (SUGGESTED blind spot).

    A path that resolves to a DIFFERENT file is a same-named OTHER symbol → EXCLUDED (a confirmed
    true-negative, not a blind spot). A non-matching unresolvable path → excluded. Recall by
    named imports; honesty by the resolved/suggested split."""
    anchor_norm = os.path.normpath(anchor_file)
    anchor_base = os.path.splitext(os.path.basename(anchor_file))[0]
    anchor_abs = os.path.normpath(os.path.join(repo, anchor_file))
    out: list[Consumer] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_EXTS):
                continue
            path = os.path.join(root, fn)
            if os.path.normpath(path) == anchor_abs:
                continue
            try:
                text = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if symbol not in text:
                continue
            rel = os.path.relpath(path, repo)
            for ref in languages.parse_imports(rel, text):      # per-language import parsing
                if ref.name != symbol:
                    continue
                target = _resolve_import(repo, rel, ref)        # module-path (TS) or symbol (Python)
                if target is not None:
                    if os.path.normpath(target[0]) == anchor_norm:
                        out.append(Consumer(rel, ref.local, ref.source or "", "resolved"))
                    # else: resolved to a DIFFERENT file → a same-named other symbol → exclude
                elif ref.source and ref.source.rstrip("/").split("/")[-1] == anchor_base:
                    out.append(Consumer(rel, ref.local, ref.source, "suggested"))   # unresolvable + basename
                break
    return out


def scan_module_consumers(repo: str, anchor_file: str, member_names: set[str]) -> list[tuple[str, dict[str, str]]]:
    """One repo walk → [(consumer_file, {member → local binding})] for every file whose import of
    one or more of `member_names` RESOLVES to `anchor_file`. Member co-occurrence (the §11.1 intent
    signal) is read straight from these named imports — no call-site resolution needed."""
    anchor_norm = os.path.normpath(anchor_file)
    anchor_abs = os.path.normpath(os.path.join(repo, anchor_file))
    out: list[tuple[str, dict[str, str]]] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_EXTS):
                continue
            path = os.path.join(root, fn)
            if os.path.normpath(path) == anchor_abs:
                continue
            try:
                text = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if not any(m in text for m in member_names):
                continue
            rel = os.path.relpath(path, repo)
            used: dict[str, str] = {}
            for ref in languages.parse_imports(rel, text):
                if ref.name not in member_names:
                    continue
                target = _resolve_import(repo, rel, ref)
                if target is None or target[0] is None or os.path.normpath(target[0]) != anchor_norm:
                    continue
                used.setdefault(ref.name, ref.local)
            if used:
                out.append((rel, used))
    return out
