"""Tests for the Resolver strategy (P0-P1.5).

Hermetic tests (no server, no network) cover the abstraction: the registry, make_resolver, the
deterministic floor, the injection point, and the `auto` fallback (LSP unavailable → floor). One
GATED integration test drives a real typescript-language-server (skipped unless bun + private-app +
its node_modules are present)."""
import os
import shutil
import time

import pytest

from src import import_scan, resolver
from src import languages

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "scan_repo")
CHECKOUT, PKG = "apps/web/checkout.ts", "@demo/lib/payments"


# --------------------------------------------------------------------------- hermetic
def test_make_resolver_det_is_none():
    assert resolver.make_resolver("det") is None         # det = the scan's built-in floor, no override


def test_make_resolver_lsp_and_auto():
    from src.lsp.resolver import DaemonResolver
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
    from src.lsp.resolver import LspResolver
    r = LspResolver(fallback=True)
    monkeypatch.setattr(r.pool, "client_for", lambda repo, f: (None, None, repo))   # no server
    got = r.resolve_module(FIX, CHECKOUT, PKG)
    assert got and got.replace("\\", "/").endswith("payments.ts")                     # the floor answered


def test_lsp_only_returns_none_without_server(monkeypatch):
    from src.lsp.resolver import LspResolver
    r = LspResolver(fallback=False)
    monkeypatch.setattr(r.pool, "client_for", lambda repo, f: (None, None, repo))
    assert r.resolve_module(FIX, CHECKOUT, PKG) is None   # lsp-only, no fallback → None


def test_daemon_resolver_degrades_to_floor(monkeypatch):
    # daemon unreachable → in-process LSP (yields nothing here) → the deterministic floor answers
    from src.lsp import daemon as dmod
    from src.lsp.resolver import DaemonResolver

    def down(*a, **k):
        raise OSError("daemon down")
    monkeypatch.setattr(dmod, "call", down)
    r = DaemonResolver(fallback=True)
    r._lsp = type("NoLsp", (), {"resolve_module": lambda self, *a: None})()   # in-proc LSP: no server
    got = r.resolve_module(FIX, CHECKOUT, PKG)
    assert got and got.replace("\\", "/").endswith("payments.ts")             # floor answered


# --------------------------------------------------------------------------- gated integration (real LSP)
_BUN = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
_PRIVATE_APP = os.path.expanduser("~/dev/private-app")
_GATED = os.path.exists(_BUN) and os.path.isdir(_PRIVATE_APP) and os.path.exists(os.path.join(_PRIVATE_APP, "node_modules/typescript"))


@pytest.mark.skipif(not _GATED, reason="integration: needs bun + ~/dev/private-app + its node_modules")
def test_lsp_resolves_tsconfig_alias_real_server():
    from src.lsp.resolver import LspResolver
    r = LspResolver(fallback=False)
    try:
        f = "components/admin/payments-tab.tsx"
        assert r.resolve_module(_PRIVATE_APP, f, "@/lib/services/payments") == "lib/services/payments.ts"
        assert r.resolve_module(_PRIVATE_APP, f, "./utils") == "components/admin/utils.tsx"
        assert r.resolve_module(_PRIVATE_APP, f, "react") is None       # node_modules = external boundary
    finally:
        r.pool.shutdown_all()


@pytest.mark.skipif(not _GATED, reason="integration: needs bun + ~/dev/private-app + its node_modules")
def test_daemon_warm_servers_reused_across_invocations(tmp_path):
    # P4: the index is paid ONCE; a second (fresh) DaemonResolver hits the same warm daemon → fast.
    from src.lsp import daemon as dmod
    from src.lsp.resolver import DaemonResolver
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
