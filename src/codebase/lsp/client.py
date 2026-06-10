"""A generic, language-agnostic LSP client — JSON-RPC over a server's stdio. Zero stack knowledge:
it speaks `initialize` / `textDocument/didOpen` / `textDocument/definition` and auto-replies to the
server→client requests (`workspace/configuration`, capability registration) that would otherwise hang
it. Promoted from the validated spike. The per-language bits (which server, which init options) live
in `src/languages/`; this file is reused unchanged across TypeScript, Python, Go, …"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time


class LspError(RuntimeError):
    pass


class LspClient:
    def __init__(self, command: list[str], cwd: str, env: dict | None = None):
        try:
            # start_new_session ⇒ the server (and any child it spawns, e.g. `bun x` → the real server)
            # is in its OWN process group, so shutdown can kill the WHOLE group — no orphaned servers.
            self.p = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, env=env or os.environ.copy(),
                                      start_new_session=True)
        except (OSError, ValueError) as exc:
            raise LspError(f"could not start LSP server {command!r}: {exc}") from exc
        self._id = 0
        self._resp: dict[int, dict] = {}
        self._cv = threading.Condition()
        self._alive = True
        threading.Thread(target=self._read_loop, daemon=True).start()

    # --- framing ---------------------------------------------------------
    def _send(self, msg: dict) -> None:
        data = json.dumps(msg).encode()
        try:
            self.p.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
            self.p.stdin.flush()
        except (BrokenPipeError, ValueError) as exc:
            raise LspError(f"LSP server pipe closed: {exc}") from exc

    def _read_loop(self) -> None:
        f = self.p.stdout
        while True:
            line = f.readline()
            if not line:
                with self._cv:
                    self._alive = False
                    self._cv.notify_all()
                return
            if not line.startswith(b"Content-Length:"):
                continue
            n = int(line.split(b":")[1].strip())
            f.readline()                              # the blank separator line
            try:
                body = json.loads(f.read(n))
            except ValueError:
                continue
            if "id" in body and "method" in body:     # server→client REQUEST → must reply or it hangs
                m = body["method"]
                res = [None] * len(body.get("params", {}).get("items", [])) if m == "workspace/configuration" else None
                self._send({"jsonrpc": "2.0", "id": body["id"], "result": res})
            elif "id" in body:                         # a response to one of our requests
                with self._cv:
                    self._resp[body["id"]] = body
                    self._cv.notify_all()

    # --- RPC -------------------------------------------------------------
    def request(self, method: str, params: dict, timeout: float = 60.0) -> dict:
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        with self._cv:
            end = time.time() + timeout
            while rid not in self._resp:
                if not self._alive:
                    raise LspError("LSP server exited")
                if not self._cv.wait(max(0.0, end - time.time())):
                    raise LspError(f"LSP request timed out: {method}")
            return self._resp.pop(rid)

    def notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    # --- convenience -----------------------------------------------------
    def initialize(self, root_uri: str, init_options: dict | None = None) -> None:
        self.request("initialize", {
            "processId": os.getpid(), "rootUri": root_uri,
            "capabilities": {"window": {"workDoneProgress": True}},
            "workspaceFolders": [{"uri": root_uri, "name": "root"}],
            "initializationOptions": init_options or {},
        })
        self.notify("initialized", {})

    def did_open(self, uri: str, language_id: str, text: str) -> None:
        self.notify("textDocument/didOpen", {"textDocument": {
            "uri": uri, "languageId": language_id, "version": 1, "text": text}})

    def definition_locs(self, uri: str, line: int, char: int, timeout: float = 12.0) -> list[tuple[str, int]]:
        """go-to-definition → [(target file, 0-based def line)], order-preserving."""
        r = self.request("textDocument/definition", {
            "textDocument": {"uri": uri}, "position": {"line": line, "character": char}}, timeout=timeout)
        locs = r.get("result") or []
        locs = locs if isinstance(locs, list) else [locs]
        out: list[tuple[str, int]] = []
        for l in locs:
            u = (l.get("uri") or l.get("targetUri") or "").replace("file://", "")
            rng = l.get("range") or l.get("targetSelectionRange") or l.get("targetRange") or {}
            ln = int((rng.get("start") or {}).get("line", 0))
            if u:
                out.append((u, ln))
        return out

    def definition(self, uri: str, line: int, char: int, timeout: float = 30.0) -> list[str]:
        """go-to-definition → list of repo-absolute target file paths (deduped, order-preserving)."""
        out: list[str] = []
        for u, _ in self.definition_locs(uri, line, char, timeout):
            if u not in out:
                out.append(u)
        return out

    def shutdown(self) -> None:
        self._alive = False
        try:
            self.notify("exit", {})
        except LspError:
            pass
        try:                                             # kill the whole process group (server + children)
            os.killpg(os.getpgid(self.p.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                self.p.terminate()
            except Exception:
                pass
