"""TypeScript / JavaScript — ALL of its specificity in one file: the deterministic FLOOR resolver
(relative paths, package.json names, tsconfig `paths` aliases) and the LSP `ServerSpec`. The generic
core never imports this directly — it goes through `src.languages`."""
from __future__ import annotations

import json
import os
import re

from .base import LanguageProvider, ServerSpec, SKIP_DIRS, bun_x

EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs")
_RESOLVE_EXTS = (".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts")


# --------------------------------------------------------------------------- deterministic floor
def _pkg_map(repo: str) -> dict[str, str]:
    """{package name → package dir (repo-relative)} from every package.json — the monorepo's
    cross-project link map (e.g. `@calcom/lib` → `packages/lib`)."""
    out: dict[str, str] = {}
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        if "package.json" in files:
            try:
                data = json.load(open(os.path.join(root, "package.json"), encoding="utf-8"))
            except (OSError, ValueError):
                continue
            name = data.get("name")
            if name:
                out.setdefault(name, os.path.relpath(root, repo))
    return out


def _strip_jsonc(text: str) -> str:
    """Strip // and /* */ comments, STRING-AWARE — tsconfig path globs like `"@/*"` and `"**/*.ts"`
    contain `/*` and `*/`, so a naive regex eats the file. Scan char-by-char, skipping strings."""
    out: list[str] = []
    i, n, in_str = 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1]); i += 2; continue
            if c == '"':
                in_str = False
            i += 1; continue
        if c == '"':
            in_str = True; out.append(c); i += 1; continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2; continue
        out.append(c); i += 1
    return "".join(out)


def _load_jsonc(path: str) -> dict | None:
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return None
    text = _strip_jsonc(text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)                      # trailing commas
    try:
        return json.loads(text)
    except ValueError:
        return None


_TS_ALIAS_CACHE: dict[str, tuple] = {}


def _tsconfig_aliases(repo: str) -> tuple:
    """`compilerOptions.paths` aliases (e.g. `"@/*": ["./*"]`) → (pattern, replacements, base_dir)
    rules. Follows one `extends`. Cached."""
    if repo in _TS_ALIAS_CACHE:
        return _TS_ALIAS_CACHE[repo]
    rules: list[tuple] = []
    for cfg in ("tsconfig.json", "jsconfig.json"):
        data = _load_jsonc(os.path.join(repo, cfg))
        if not data:
            continue
        co = dict(data.get("compilerOptions") or {})
        paths = co.get("paths") or {}
        base = co.get("baseUrl") or "."
        if not paths and isinstance(data.get("extends"), str):
            ext = _load_jsonc(os.path.normpath(os.path.join(repo, data["extends"])))
            if ext:
                eco = ext.get("compilerOptions") or {}
                paths = eco.get("paths") or {}
                base = co.get("baseUrl") or eco.get("baseUrl") or "."
        for pat, repls in paths.items():
            if isinstance(repls, list):
                rules.append((pat, tuple(repls), base))
        if rules:
            break
    out = tuple(rules)
    _TS_ALIAS_CACHE[repo] = out
    return out


def _resolve_file(repo: str, base_rel: str) -> str | None:
    """A bare module path (no extension) → an actual repo-relative file, probing extensions + /index."""
    cand = os.path.normpath(os.path.join(repo, base_rel))
    for ext in _RESOLVE_EXTS:
        if os.path.isfile(cand + ext):
            return os.path.relpath(cand + ext, repo)
    if os.path.isfile(cand):
        return os.path.relpath(cand, repo)
    for ext in _RESOLVE_EXTS:
        idx = os.path.join(cand, "index" + ext)
        if os.path.isfile(idx):
            return os.path.relpath(idx, repo)
    return None


def _resolve_alias(repo: str, source: str) -> str | None:
    for pat, repls, base in _tsconfig_aliases(repo):
        if "*" in pat:
            pre, _, suf = pat.partition("*")
            if source.startswith(pre) and source.endswith(suf):
                cap = source[len(pre): len(source) - len(suf)] if suf else source[len(pre):]
                for r in repls:
                    rpre, _, rsuf = r.partition("*")
                    hit = _resolve_file(repo, os.path.normpath(os.path.join(base, rpre + cap + rsuf)))
                    if hit:
                        return hit
        elif source == pat:
            for r in repls:
                hit = _resolve_file(repo, os.path.normpath(os.path.join(base, r)))
                if hit:
                    return hit
    return None


def resolve_module(repo: str, importing_file: str, source: str, pkgs: dict[str, str]) -> str | None:
    """Resolve an import `source` → repo-relative file (relative / package name / tsconfig alias), or
    None (a genuine external/node_modules boundary). The TS/JS deterministic FLOOR."""
    if source.startswith("."):
        return _resolve_file(repo, os.path.join(os.path.dirname(importing_file), source))
    for name in sorted(pkgs, key=len, reverse=True):     # longest package name wins
        if source == name or source.startswith(name + "/"):
            sub = source[len(name):].lstrip("/")
            return _resolve_file(repo, os.path.join(pkgs[name], sub) if sub else pkgs[name])
    return _resolve_alias(repo, source)


_PKG_CACHE: dict[str, dict[str, str]] = {}


def floor_resolve(repo: str, importing_file: str, source: str) -> str | None:
    """The provider entry point — computes the package map itself (cached per repo)."""
    if repo not in _PKG_CACHE:
        _PKG_CACHE[repo] = _pkg_map(repo)
    return resolve_module(repo, importing_file, source, _PKG_CACHE[repo])


# --------------------------------------------------------------------------- LSP server spec
def _language_id(file: str) -> str:
    f = file.lower()
    return ("typescriptreact" if f.endswith(".tsx") else "javascriptreact" if f.endswith(".jsx")
            else "javascript" if f.endswith((".js", ".mjs", ".cjs")) else "typescript")


def _init(repo: str) -> dict:
    # use the PROJECT's TypeScript (supports `moduleResolution: "bundler"` etc.); the bundled one fails.
    proj_ts = os.path.join(repo, "node_modules/typescript/lib/tsserver.js")
    return {"tsserver": {"path": proj_ts}} if os.path.exists(proj_ts) else {}


# A directory holding an `index.*` is a Node/Deno module ENTRY (a thing you import/enter by dir name).
_MODULE_ENTRY = re.compile(r"^index\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$")


def _entrypoint(ctx) -> int | None:
    """Main entry INSIDE an `index.*`: a top-level handler-registration CALL (`serve(...)` /
    `Deno.serve(...)` / `app.get(...)`) → else `export default` → else the first top-level statement
    that isn't a comment / import. `ctx` is a tree-sitter `_Ctx` (used by duck-typing, not imported)."""
    top = ctx.children(ctx.root)
    call = next((n for n in top if n.kind() == "expression_statement"
                 and ctx.children(n) and "call" in ctx.children(n)[0].kind()), None)
    if call is not None:
        return ctx.span(call)[0]
    deflt = next((n for n in top if n.kind() == "export_statement" and "default" in ctx.text(n)[:30]), None)
    if deflt is not None:
        return ctx.span(deflt)[0]
    real = next((n for n in top if n.kind() not in ("comment", "import_statement", "hash_bang_line")), None)
    return ctx.span(real)[0] if real is not None else None


PROVIDER = LanguageProvider(
    name="typescript",
    extensions=EXTENSIONS,
    resolve=floor_resolve,
    module_entry=_MODULE_ENTRY,
    entrypoint=_entrypoint,
    lsp=ServerSpec(
        language="typescript",
        command=bun_x("typescript-language-server", "--stdio"),
        language_id=_language_id,
        root_markers=("tsconfig.json", "jsconfig.json", "package.json"),
        init_options=_init,
        status="full",
        notes="MUST pin the project's node_modules/typescript (bundled TS fails on moduleResolution: bundler).",
    ),
)


# import { A, B as C } from "src";  /  import D from "src";  /  import * as E from "src"
# DOTALL so a multi-line `{ ... }` named block (common in TS) is captured whole. Used by the codebase
# import-SCAN (diff-mode keeps its own copy in diff/lang.py — the two modes don't share a regex).
_IMPORT_RE = re.compile(
    r'import\s+(?:type\s+)?'
    r'(?:([A-Za-z_$][\w$]*)\s*,?\s*)?'          # default binding
    r'(?:\*\s*as\s*[A-Za-z_$][\w$]*\s*)?'       # namespace (binding ignored)
    r'(?:\{([^}]*)\}\s*)?'                       # named block (may span lines)
    r'from\s*["\']([^"\']+)["\']',
    re.DOTALL,
)
