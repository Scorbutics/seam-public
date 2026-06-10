"""LspResolver — resolve an import through a real language server (go-to-definition on the module
string), so `@/` aliases / node_modules / sys.path / #include are the SERVER's job, not ours.

`fallback=True` (the `auto` mode) drops to the deterministic floor when the LSP can't answer (no
server, unsupported language, a genuine external, or a miss) — so it's strictly a precision upgrade,
never a regression. Direction: RESOLVE/down only; discovery stays the deterministic grep."""
from __future__ import annotations

import os
import time

from .pool import LspPool


def _module_string_pos(repo: str, file: str, source: str):
    """0-based (line, char) just inside the quoted module string `source` in `file`, or None."""
    try:
        text = open(os.path.join(repo, file), encoding="utf-8", errors="ignore").read()
    except OSError:
        return None
    for q in ('"' + source + '"', "'" + source + "'", "`" + source + "`"):
        idx = text.find(q)
        if idx >= 0:
            inside = idx + 2                          # one char into the string content
            line0 = text.count("\n", 0, inside)
            char = inside - (text.rfind("\n", 0, inside) + 1)
            return line0, char
    return None


class LspResolver:
    def __init__(self, fallback: bool = True, pool: LspPool | None = None, ready_timeout: float = 25.0):
        self.fallback = fallback
        self.pool = pool or LspPool()
        self.ready_timeout = ready_timeout
        self._ready: set[tuple[str, str]] = set()    # (language, root) that have loaded at least once
        self._det = None

    def resolve_module(self, repo: str, importing_file: str, source: str) -> str | None:
        repo = os.path.expanduser(repo)
        try:
            target = self._lsp(repo, importing_file, source)
        except Exception:
            target = None
        if target is None and self.fallback:
            return self._floor(repo, importing_file, source)
        return target

    # --- LSP path --------------------------------------------------------
    def _lsp(self, repo: str, importing_file: str, source: str) -> str | None:
        c, spec, root = self.pool.client_for(repo, importing_file)
        if c is None:                                # unsupported language / server unobtainable
            return None
        uri = self.pool.ensure_open(c, repo, importing_file, spec)
        pos = _module_string_pos(repo, importing_file, source)
        if uri is None or pos is None:
            return None
        line, char = pos
        self_abs = os.path.abspath(os.path.join(repo, importing_file))

        def query():
            for t in c.definition(uri, line, char):
                if os.path.abspath(t) == self_abs:
                    continue                         # the import binding / not-yet-resolved
                rel = os.path.relpath(t, repo)
                # node_modules or outside the repo = the EXTERNAL boundary (the floor returns None too)
                if rel.startswith("..") or "node_modules" in rel.split(os.sep):
                    continue
                return rel
            return None

        key = (spec.language, root)
        if key not in self._ready:                   # first query absorbs the one-time project index
            deadline = time.time() + self.ready_timeout
            while time.time() < deadline:
                r = query()
                if r is not None:
                    self._ready.add(key)
                    return r
                time.sleep(0.4)
            self._ready.add(key)                     # give up polling; serve one-shot henceforth
            return None
        return query()

    # --- exact symbol resolution (P1.5) ----------------------------------
    def resolve_symbol(self, repo: str, file: str, line: int, col: int):
        """go-to-definition at (file, line, col) → (repo-relative target file, 0-based def line), or
        None. Lets the scan land the EXACT definition instead of re-parsing the resolved module."""
        repo = os.path.expanduser(repo)
        try:
            c, spec, _root = self.pool.client_for(repo, file)
            if c is None:
                return None
            uri = self.pool.ensure_open(c, repo, file, spec)
            if uri is None:
                return None
            for t, ln in c.definition_locs(uri, line, col):
                rel = os.path.relpath(t, repo)
                if not rel.startswith("..") and "node_modules" not in rel.split(os.sep):
                    return rel, ln
        except Exception:
            pass
        return None

    # --- deterministic floor (auto fallback) -----------------------------
    def _floor(self, repo: str, importing_file: str, source: str) -> str | None:
        if self._det is None:
            from ..resolver import DeterministicResolver
            self._det = DeterministicResolver()
        return self._det.resolve_module(repo, importing_file, source)


class DaemonResolver:
    """The production resolver (P4): resolve through the persistent daemon's WARM servers — the index
    is paid once per machine, reused by every invocation. Degrades cleanly: daemon unreachable →
    in-process LSP; LSP miss/None + `fallback` → the deterministic floor. Never a hard failure."""

    def __init__(self, fallback: bool = True, sock: str | None = None):
        from . import daemon
        self._daemon = daemon
        self.fallback = fallback
        self.sock = sock or daemon.default_socket()
        self._lsp = None                             # in-process LSP, only if the daemon is down
        self._det = None

    def resolve_module(self, repo: str, importing_file: str, source: str) -> str | None:
        repo = os.path.expanduser(repo)
        try:
            target = self._daemon.call(self.sock, {"op": "resolve_module", "repo": repo,
                                                   "file": importing_file, "source": source})
        except OSError:
            target = self._inproc().resolve_module(repo, importing_file, source)  # daemon down
        if target is None and self.fallback:
            return self._floor(repo, importing_file, source)
        return target

    def resolve_symbol(self, repo: str, file: str, line: int, col: int):
        repo = os.path.expanduser(repo)
        try:
            r = self._daemon.call(self.sock, {"op": "resolve_symbol", "repo": repo,
                                              "file": file, "line": line, "col": col})
        except OSError:
            return self._inproc().resolve_symbol(repo, file, line, col)
        return tuple(r) if r else None

    def _inproc(self):
        if self._lsp is None:
            self._lsp = LspResolver(fallback=False)
        return self._lsp

    def _floor(self, repo: str, importing_file: str, source: str) -> str | None:
        if self._det is None:
            from ..resolver import DeterministicResolver
            self._det = DeterministicResolver()
        return self._det.resolve_module(repo, importing_file, source)
