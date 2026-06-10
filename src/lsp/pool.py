"""LspPool — one warm server per (language, project-root), started lazily and reused for every query,
shut down at process exit. This is what turns the one-time project index (~5.5s for TS) into a
once-per-session cost instead of per-query. A server that can't be obtained/started yields None, so
the caller degrades to the deterministic floor — never a hard failure."""
from __future__ import annotations

import atexit
import os

from . import client as _client
from . import registry


class LspPool:
    def __init__(self) -> None:
        self._clients: dict[tuple[str, str], object] = {}   # (language, root) -> LspClient | None
        self._open: set[tuple[int, str]] = set()
        atexit.register(self.shutdown_all)

    def client_for(self, repo: str, file: str):
        """(LspClient|None, ServerSpec|None, root). None client ⇒ unsupported lang / no server."""
        spec = registry.spec_for_file(file)
        if spec is None:
            return None, None, repo
        root = registry.project_root(repo, file, spec)
        key = (spec.language, root)
        if key not in self._clients:
            self._clients[key] = self._start(spec, root)
        return self._clients[key], spec, root

    def _start(self, spec, root):
        cmd = spec.command(root)
        if not cmd:
            return None                              # server binary not obtainable on this machine
        env = dict(os.environ)
        env["PATH"] = os.path.expanduser("~/.bun/bin") + os.pathsep + env.get("PATH", "")
        try:
            c = _client.LspClient(cmd, cwd=root, env=env)
            init = spec.init_options(root) if callable(spec.init_options) else (spec.init_options or {})
            c.initialize("file://" + root, init)
            return c
        except _client.LspError:
            return None

    def ensure_open(self, c, repo: str, file: str, spec) -> str | None:
        uri = "file://" + os.path.join(repo, file)
        k = (id(c), uri)
        if k not in self._open:
            try:
                text = open(os.path.join(repo, file), encoding="utf-8", errors="ignore").read()
            except OSError:
                return None
            c.did_open(uri, registry.language_id_for(spec, file), text)
            self._open.add(k)
        return uri

    def shutdown_all(self) -> None:
        for c in self._clients.values():
            if c is not None:
                try:
                    c.shutdown()
                except Exception:
                    pass
        self._clients.clear()
        self._open.clear()
