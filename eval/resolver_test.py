"""Tests for the Resolver strategy (P0-P1.5).

Hermetic tests (no server, no network) cover the abstraction: the registry, make_resolver, the
deterministic floor, the injection point, and the `auto` fallback (LSP unavailable → floor). One
GATED integration test drives a real typescript-language-server (skipped unless bun + private-app +
its node_modules are present)."""
import os
import shutil
import time

import pytest

from src.codebase import import_scan, resolver
from src.codebase import languages

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "scan_repo")
CHECKOUT, PKG = "apps/web/checkout.ts", "@demo/lib/payments"


# --------------------------------------------------------------------------- hermetic
def test_make_resolver_det_is_none():
    assert resolver.make_resolver("det") is None         # det = the scan's built-in floor, no override


def test_make_resolver_lsp_and_auto():
    from src.codebase.lsp.resolver import DaemonResolver
    assert isinstance(resolver.make_resolver("lsp"), DaemonResolver)
    r = resolver.make_resolver("auto")
    assert isinstance(r, DaemonResolver) and r.fallback is True


def test_registry_ext_to_language():
    assert languages.spec_for_file("a/b/c.tsx").language == "typescript"
    assert languages.spec_for_file("x.py").language == "python"
    assert languages.spec_for_file("x.kt").language == "kotlin"
    assert languages.spec_for_file("x.cpp").language == "cpp"
    assert languages.spec_for_file("x.rb").language == "ruby"
    assert languages.spec_for_file("README.md") is None   # unsupported → caller keeps the floor


def test_registry_language_id_per_file():
    ts = languages.spec_for_file("x.ts")
    assert languages.language_id_for(ts, "a.tsx") == "typescriptreact"
    assert languages.language_id_for(ts, "a.ts") == "typescript"
    assert languages.language_id_for(ts, "a.jsx") == "javascriptreact"


def test_deterministic_resolver_matches_floor():
    got = resolver.DeterministicResolver().resolve_module(FIX, CHECKOUT, PKG)
    assert got and got.replace("\\", "/").endswith("payments.ts")


def test_injection_point_uses_active_resolver():
    class Stub:
        def resolve_module(self, repo, f, source):
            return "STUB"
    import_scan.set_resolver(Stub())
    try:
        assert import_scan._resolve("r", "f", "s", {}) == "STUB"
    finally:
        import_scan.set_resolver(None)
    # default (no override) = the deterministic floor
    assert import_scan._resolve(FIX, CHECKOUT, PKG, import_scan._pkg_map(FIX)).replace("\\", "/").endswith("payments.ts")


def test_auto_falls_back_to_floor_when_no_server(monkeypatch):
    from src.codebase.lsp.resolver import LspResolver
    r = LspResolver(fallback=True)
    monkeypatch.setattr(r.pool, "client_for", lambda repo, f: (None, None, repo))   # no server
    got = r.resolve_module(FIX, CHECKOUT, PKG)
    assert got and got.replace("\\", "/").endswith("payments.ts")                     # the floor answered


def test_lsp_only_returns_none_without_server(monkeypatch):
    from src.codebase.lsp.resolver import LspResolver
    r = LspResolver(fallback=False)
    monkeypatch.setattr(r.pool, "client_for", lambda repo, f: (None, None, repo))
    assert r.resolve_module(FIX, CHECKOUT, PKG) is None   # lsp-only, no fallback → None


def test_daemon_resolver_degrades_to_floor(monkeypatch):
    # daemon unreachable → in-process LSP (yields nothing here) → the deterministic floor answers
    from src.codebase.lsp import daemon as dmod
    from src.codebase.lsp.resolver import DaemonResolver

    def down(*a, **k):
        raise OSError("daemon down")
    monkeypatch.setattr(dmod, "call", down)
    r = DaemonResolver(fallback=True)
    r._lsp = type("NoLsp", (), {"resolve_module": lambda self, *a: None})()   # in-proc LSP: no server
    got = r.resolve_module(FIX, CHECKOUT, PKG)
    assert got and got.replace("\\", "/").endswith("payments.ts")             # floor answered


def test_python_import_parser():
    from src.codebase.languages import python
    src = "from .atoms import _Ctx, available as av\nimport os\nfrom x import *  # noqa\n"
    got = {n for n, _, _ in python.parse_imports(src)}
    assert {"_Ctx", "available", "os"} <= got     # named + `as`-original + module import
    assert "av" not in got and "*" not in got      # alias + star excluded


# --------------------------------------------------------------------------- gated integration (real LSP)
import glob  # noqa: E402

_BUN = bool(shutil.which("bun") or os.path.exists(os.path.expanduser("~/.bun/bin/bun")))
_PRIVATE_APP = os.path.expanduser("~/dev/private-app")
_GATED = _BUN and os.path.isdir(_PRIVATE_APP) and os.path.exists(os.path.join(_PRIVATE_APP, "node_modules/typescript"))
_PYRIGHT = _BUN and bool(glob.glob(os.path.expanduser("~/.bun/install/cache/pyright@*")))
_PY_REPO = os.path.join(FIX, "..", "py_repo")           # a tiny Python project (fast pyright index)
_PY_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "fixtures", "py_repo"))


@pytest.mark.integration
@pytest.mark.skipif(not _PYRIGHT, reason="integration: needs bun + a cached pyright (P2 cross-language)")
def test_python_dependency_graph_via_lsp():
    # P2 DOWN — parse `from core import process, Engine` and resolve each via pyright go-to-def.
    from src.codebase import import_scan
    from src.codebase.lsp.resolver import LspResolver
    r = LspResolver(fallback=False)
    import_scan.set_resolver(r)
    try:
        g = import_scan.build_dependency_graph(_PY_REPO, "app.py", "handle")
        deps = {n["symbol"]: n["file"].replace("\\", "/") for n in g["nodes"] if n["id"] != "n1"}
        assert deps.get("process") == "core.py" and deps.get("Engine") == "core.py"
    finally:
        import_scan.set_resolver(None)
        r.pool.shutdown_all()


@pytest.mark.integration
@pytest.mark.skipif(not _PYRIGHT, reason="integration: needs bun + a cached pyright (P2 cross-language)")
def test_python_consumers_graph_via_lsp():
    # P2 UP — who imports `process` (defined in core.py): app.py + admin.py, confirmed via pyright.
    from src.codebase import import_scan
    from src.codebase.lsp.resolver import LspResolver
    r = LspResolver(fallback=False)
    import_scan.set_resolver(r)
    try:
        g = import_scan.build_consumers_graph(_PY_REPO, "core.py", "process")
        consumers = {n["file"].replace("\\", "/") for n in g["nodes"] if n["id"] != "n1"}
        assert "app.py" in consumers and "admin.py" in consumers
        assert all(e["provenance"] == "RESOLVED_FULL" for e in g["edges"])   # LSP-confirmed
    finally:
        import_scan.set_resolver(None)
        r.pool.shutdown_all()


@pytest.mark.integration
@pytest.mark.skipif(not _GATED, reason="integration: needs bun + ~/dev/private-app + its node_modules")
def test_lsp_resolves_tsconfig_alias_real_server():
    from src.codebase.lsp.resolver import LspResolver
    r = LspResolver(fallback=False)
    try:
        f = "components/admin/payments-tab.tsx"
        assert r.resolve_module(_PRIVATE_APP, f, "@/lib/services/payments") == "lib/services/payments.ts"
        assert r.resolve_module(_PRIVATE_APP, f, "./utils") == "components/admin/utils.tsx"
        assert r.resolve_module(_PRIVATE_APP, f, "react") is None       # node_modules = external boundary
    finally:
        r.pool.shutdown_all()


@pytest.mark.integration
@pytest.mark.skipif(not _GATED, reason="integration: needs bun + ~/dev/private-app + its node_modules")
def test_daemon_warm_servers_reused_across_invocations(tmp_path):
    # P4: the index is paid ONCE; a second (fresh) DaemonResolver hits the same warm daemon → fast.
    from src.codebase.lsp import daemon as dmod
    from src.codebase.lsp.resolver import DaemonResolver
    sock = str(tmp_path / "seam-lsp-test.sock")
    f = "components/admin/payments-tab.tsx"
    try:
        t = time.time()
        a = DaemonResolver(fallback=False, sock=sock).resolve_module(_PRIVATE_APP, f, "@/lib/services/payments")
        first = time.time() - t
        assert a == "lib/services/payments.ts"
        t = time.time()
        b = DaemonResolver(fallback=False, sock=sock).resolve_module(_PRIVATE_APP, f, "@/components/ui/badge")
        second = time.time() - t
        assert b == "components/ui/badge.tsx"
        assert second < first                        # warm reuse: the 2nd invocation didn't re-index
    finally:
        try:
            dmod.call(sock, {"op": "shutdown"})
        except OSError:
            pass
