"""The language registry — aggregates the per-language providers and is the ONLY thing the generic
core (import_scan, resolver, lsp/*) imports for anything language-specific. Adding a language: add a
`src/languages/<name>.py` exposing `PROVIDER`, then list it here."""
from __future__ import annotations

import os

from . import c, cpp, java, kotlin, python, ruby, typescript
from .base import LanguageProvider, ServerSpec, SKIP_DIRS  # noqa: F401 (re-exported for the core)

PROVIDERS: tuple[LanguageProvider, ...] = (
    typescript.PROVIDER, python.PROVIDER, java.PROVIDER, kotlin.PROVIDER,
    ruby.PROVIDER, c.PROVIDER, cpp.PROVIDER,
)


def provider_for(file: str) -> LanguageProvider | None:
    f = file.lower()
    return next((p for p in PROVIDERS if f.endswith(p.extensions)), None)


# Every source-file extension across all providers — the language-agnostic "is this a source file"
# set for repo walks (replaces hardcoded per-language extension tuples in the generic scan).
SOURCE_EXTS: tuple[str, ...] = tuple({ext for p in PROVIDERS for ext in p.extensions})


# --- deterministic floor (per language) ----------------------------------
def floor_resolve(repo: str, importing_file: str, source: str) -> str | None:
    """Resolve via the importing file's language FLOOR (TS today). No floor for a language ⇒ None."""
    p = provider_for(importing_file)
    return p.resolve(repo, importing_file, source) if (p and p.resolve) else None


# --- LSP spec lookups (were lsp/registry.py) -----------------------------
def spec_for_file(file: str) -> ServerSpec | None:
    p = provider_for(file)
    return p.lsp if p else None


def language_id_for(spec: ServerSpec, file: str) -> str:
    return spec.language_id(file) if callable(spec.language_id) else spec.language_id


def project_root(repo: str, file: str, spec: ServerSpec) -> str:
    """Nearest ancestor dir (within repo) holding a root marker; else the repo itself."""
    d = os.path.dirname(os.path.join(repo, file))
    repo = os.path.abspath(repo)
    while os.path.abspath(d).startswith(repo) and os.path.abspath(d) != repo:
        if any(os.path.exists(os.path.join(d, m)) for m in spec.root_markers):
            return os.path.abspath(d)
        d = os.path.dirname(d)
    return repo


# --- module-entry convention + entrypoint (per language; tier 2 of the edge ladder) -------
def is_module_entry(file: str) -> bool:
    """True if `file`'s basename marks a module ENTRY in ANY language (TS/JS `index.*`, Python
    `__init__.py`, …). Checked across all providers (not via `provider_for`) so the convention isn't
    coupled to extension dispatch — a string-dispatch target is endpoint-shaped regardless of caller."""
    base = os.path.basename(file)
    return any(p.module_entry and p.module_entry.match(base) for p in PROVIDERS)


def parse_imports(file: str, text: str) -> list:
    """The file's imports as `ImportRef`s, via its language provider — the uniform unit the generic
    scan consumes (TS: source-string imports → module-path resolve; Python: source=None → symbol
    resolve). Empty list if the language has no import parser yet."""
    p = provider_for(file)
    return p.imports(text) if (p and p.imports) else []


def entrypoint_line(file: str, ctx) -> int:
    """The MAIN entrypoint line inside a module entry, via the file's language heuristic (TS: a
    top-level handler call / `export default`; Python: `if __name__=='__main__'` / a top-level call).
    0 when the language has no heuristic or it can't decide."""
    p = provider_for(file)
    return (p.entrypoint(ctx) or 0) if (p and p.entrypoint) else 0
