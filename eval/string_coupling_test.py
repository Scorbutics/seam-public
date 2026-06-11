"""Tier-2 of the edge ladder — string-dispatch couplings (RESOLVED_PARTIAL), hermetic.

A distinctive string literal in a call that names a UNIQUE module entry (`index.*`) → a
RESOLVED_PARTIAL `dispatch` edge to it; a distinctive string that names NO entry → nothing
(no false positive). Framework-agnostic: the fixture is plain TS, no Supabase knowledge."""
from __future__ import annotations

import os

import pytest

from src.codebase import import_scan, string_coupling
from src.codebase.atoms import available
from src.core.resolve.languages.base import SKIP_DIRS

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "dispatch_repo")
_needs_ts = pytest.mark.skipif(not available(), reason="needs tree-sitter")


@_needs_ts
def test_string_dispatch_resolves_to_module_entry():
    g = import_scan.build_dependency_graph(FIX, "caller.ts", "go")
    disp = [(e, next(n for n in g["nodes"] if n["id"] == e["to"]))
            for e in g["edges"] if e["kind"] == "dispatch"]
    assert len(disp) == 1                                   # exactly the one real coupling
    edge, tgt = disp[0]
    assert edge["provenance"] == "RESOLVED_PARTIAL"         # tier 2 (both ends validated, not asserted-full)
    assert tgt["symbol"] == "my-handler"
    assert tgt["file"].replace("\\", "/") == "handlers/my-handler/index.ts"


@_needs_ts
def test_no_false_positive_for_string_naming_no_entry():
    g = import_scan.build_dependency_graph(FIX, "caller.ts", "go")
    # `plain-value` is distinctive (kebab) but names no module entry → no edge, no node, no blind spot.
    assert not any(n.get("symbol") == "plain-value" for n in g["nodes"])
    assert not g["blindspots"]


def test_module_entry_index_only_indexes_index_files():
    idx = string_coupling.module_entry_index(FIX, SKIP_DIRS)
    assert idx.get("my-handler") == ["handlers/my-handler/index.ts"]
    assert "caller" not in idx                              # a plain .ts file is NOT a module entry
