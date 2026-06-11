"""Blast-radius (diff-mode codebase context): who OUTSIDE the diff consumes a changed symbol.
Hermetic — a tmp monorepo, the deterministic floor, no server."""
from __future__ import annotations

from src.diff import parser
from src.diff.blast_radius import consumers_for
from src.diff.seams import emit_seams_json

_PATCH = """\
diff --git a/packages/lib/widget.ts b/packages/lib/widget.ts
--- a/packages/lib/widget.ts
+++ b/packages/lib/widget.ts
@@ -0,0 +1,3 @@
+export function MyWidget() {
+  return 1;
+}
"""


def _repo(tmp_path):
    (tmp_path / "packages" / "lib").mkdir(parents=True)
    (tmp_path / "apps" / "web").mkdir(parents=True)
    (tmp_path / "packages" / "lib" / "package.json").write_text('{"name": "@demo/lib"}\n')
    (tmp_path / "packages" / "lib" / "widget.ts").write_text(
        "export function MyWidget() {\n  return 1;\n}\n")
    # a RESOLVED consumer: imports via the package name, which resolves to the changed file
    (tmp_path / "apps" / "web" / "consumer.ts").write_text(
        'import { MyWidget } from "@demo/lib/widget";\nexport const x = MyWidget();\n')
    # a SUGGESTED consumer: an unresolvable alias whose basename matches the changed file
    (tmp_path / "apps" / "web" / "aliased.ts").write_text(
        'import { MyWidget } from "~/widget";\nexport const y = MyWidget();\n')
    return str(tmp_path)


def test_consumers_resolved_and_suggested(tmp_path):
    repo = _repo(tmp_path)
    hunks = parser.parse(_PATCH)
    assert len(hunks) == 1
    got = consumers_for(hunks, repo)
    rows = got[hunks[0].id]
    by_status = {r["status"]: r for r in rows}
    assert by_status["resolved"]["file"].replace("\\", "/") == "apps/web/consumer.ts"
    assert by_status["suggested"]["file"].replace("\\", "/") == "apps/web/aliased.ts"
    assert all(r["symbol"] == "MyWidget" for r in rows)


def test_no_repo_is_empty(tmp_path):
    hunks = parser.parse(_PATCH)
    assert consumers_for(hunks, None) == {}


def test_emit_seams_omits_consumers_when_off(tmp_path):
    """The contract is unchanged when blast-radius is off: no `consumers` key anywhere."""
    repo = _repo(tmp_path)
    hunks = parser.parse(_PATCH)
    for h in hunks:                       # give the hunk a role so it lands in a seam
        h.role = "core"
        h.seam = h.id
    off = emit_seams_json(hunks, repo=repo, blast_radius=False)
    blob = str(off)
    assert "consumers" not in blob
    on = emit_seams_json(hunks, repo=repo, blast_radius=True)
    # the changed symbol's consumers now ride along on the hunk
    hunk_dicts = [hk for cl in on["clusters"] for s in cl["seams"] for hk in s["hunks"]]
    assert any("consumers" in hk for hk in hunk_dicts)
