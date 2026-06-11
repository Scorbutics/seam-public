"""P4 — a persistent LSP daemon. The one-time project index (~5.5s for TS) is paid ONCE per machine
and reused by every later scan/invocation, instead of once per `decompose.py` run. The daemon holds a
warm `LspResolver` (its `LspPool` keeps the servers alive) behind a unix socket; clients
(`DaemonResolver`) connect-or-spawn it and send newline-delimited JSON requests. It shuts itself down
after an idle TTL, releasing the servers. If it can't be reached, the client degrades to in-process
LSP, then to the deterministic floor — never a hard failure.

Protocol (one JSON object per line, request → response):
  {"op":"resolve_module","repo":..,"file":..,"source":..}  -> {"result": <relpath|null>}
  {"op":"resolve_symbol","repo":..,"file":..,"line":..,"col":..} -> {"result": [relpath,line]|null}
  {"op":"ping"}      -> {"result":"pong"}
  {"op":"shutdown"}  -> {"result":"bye"}   (then the daemon exits — used by tests)
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time

IDLE_TTL = 900.0          # seconds with no connection before the daemon frees its servers and exits
_SPAWN_WAIT = 30.0        # seconds to wait for a freshly-spawned daemon's socket


def default_socket() -> str:
    base = os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()
    return os.path.join(base, f"seam-lsp-{os.getuid()}.sock")


_DAEMON_MODULE = "src.core.resolve.lsp.daemon"


def _pkg_cwd() -> str:
    """The dir containing the `src` package, so a spawned `python -m <_DAEMON_MODULE>` resolves.
    This file is src/core/resolve/lsp/daemon.py → five dirnames up is the repo root (the `src` parent)."""
    d = os.path.abspath(__file__)
    for _ in range(5):
        d = os.path.dirname(d)
    return d


# --------------------------------------------------------------------------- daemon side
def serve(sock_path: str) -> None:
    from .resolver import LspResolver
    res = LspResolver(fallback=False)                # the daemon does LSP-only; clients add the floor

    if os.path.exists(sock_path):
        os.unlink(sock_path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    srv.listen(8)
    srv.settimeout(IDLE_TTL)
    try:
        while True:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                break                                # idle → release servers and exit
            with conn:
                if _handle(conn, res):               # returns True on an explicit shutdown
                    break
    finally:
        try:
            res.pool.shutdown_all()
        except Exception:
            pass
        srv.close()
        if os.path.exists(sock_path):
            os.unlink(sock_path)


def _handle(conn: socket.socket, res) -> bool:
    f = conn.makefile("rwb")
    for line in f:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        op = req.get("op")
        try:
            if op == "resolve_module":
                out = res.resolve_module(req["repo"], req["file"], req["source"])
            elif op == "resolve_symbol":
                out = res.resolve_symbol(req["repo"], req["file"], req["line"], req["col"])
            elif op == "ping":
                out = "pong"
            elif op == "shutdown":
                f.write(json.dumps({"result": "bye"}).encode() + b"\n"); f.flush()
                return True
            else:
                out = None
        except Exception:
            out = None
        f.write(json.dumps({"result": out}).encode() + b"\n")
        f.flush()
    return False


# --------------------------------------------------------------------------- client side
def _connect(sock_path: str):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(sock_path)
    return s


def ensure_daemon(sock_path: str):
    """Connect to the daemon, spawning a detached one if absent. Returns a socket, or raises OSError."""
    try:
        return _connect(sock_path)
    except OSError:
        pass
    subprocess.Popen([sys.executable, "-m", _DAEMON_MODULE, sock_path], cwd=_pkg_cwd(),
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    end = time.time() + _SPAWN_WAIT
    while time.time() < end:
        try:
            return _connect(sock_path)
        except OSError:
            time.sleep(0.1)
    raise OSError("seam-lsp daemon did not come up")


def call(sock_path: str, req: dict, timeout: float = 60.0):
    """One request → its `result`. Raises OSError on connect/IO failure (caller degrades)."""
    s = ensure_daemon(sock_path)
    s.settimeout(timeout)
    try:
        f = s.makefile("rwb")
        f.write(json.dumps(req).encode() + b"\n")
        f.flush()
        line = f.readline()
        if not line:
            raise OSError("daemon closed the connection")
        return json.loads(line).get("result")
    finally:
        s.close()


if __name__ == "__main__":
    serve(sys.argv[1] if len(sys.argv) > 1 else default_socket())
