"""ResolvedFactsProvider + the additive resolved-wiring it unlocks — the diff read in the context
of the real repo. Hermetic: a tmp monorepo, the deterministic floor, no server."""
from __future__ import annotations

from src.diff import classifier_det, parser
from src.diff.facts import RegexFactsProvider
from src.diff.facts_resolve import ResolvedFactsProvider

# Hunk A modifies packages/lib/x.ts (adds branching logic → a CORE) but does NOT (re)define
# `helper` there — `helper` lives in the file's UNCHANGED body. Hunk B, in another file, imports
# `helper` from "@demo/lib/x" and uses it. The shared-symbol grounding can't link them (`helper`
# is not new-vocab); the resolved import can.
_PATCH = """\
diff --git a/packages/lib/x.ts b/packages/lib/x.ts
--- a/packages/lib/x.ts
+++ b/packages/lib/x.ts
@@ -10,2 +10,5 @@ export function compute() {
   const a = 1;
+  if (a > 0) {
+    return helper(a);
+  }
   return a;
diff --git a/apps/web/y.ts b/apps/web/y.ts
--- a/apps/web/y.ts
+++ b/apps/web/y.ts
@@ -0,0 +1,2 @@
+import { helper } from "@demo/lib/x";
+export const y = helper();
"""


def _repo(tmp_path):
    (tmp_path / "packages" / "lib").mkdir(parents=True)
    (tmp_path / "packages" / "lib" / "package.json").write_text('{"name": "@demo/lib"}\n')
    (tmp_path / "packages" / "lib" / "x.ts").write_text(
        "export function helper(n) { return n + 1; }\nexport function compute() {\n  return 0;\n}\n")
    (tmp_path / "apps" / "web").mkdir(parents=True)
    return str(tmp_path)


def _classify(hunks, provider):
    work = [h for h in hunks if h.role != "noise"]
    facts = provider.facts(work)
    classifier_det.assign_roles(work, facts)
    classifier_det.assign_wiring(work, facts)


def test_resolved_provider_populates_resolved_refs(tmp_path):
    repo = _repo(tmp_path)
    hunks = parser.parse(_PATCH)
    b = next(h for h in hunks if h.file_path.endswith("y.ts"))
    facts = ResolvedFactsProvider(RegexFactsProvider(), repo).facts(hunks)
    # `helper` (defined in x.ts's unchanged body, imported by B) resolves to the changed file
    assert facts[b.id].resolved_refs.get("helper", "").replace("\\", "/") == "packages/lib/x.ts"
    # the regex base alone never fills resolved_refs (so non-resolve runs are unchanged)
    assert RegexFactsProvider().facts(hunks)[b.id].resolved_refs == {}


def test_resolved_wiring_links_across_files(tmp_path):
    repo = _repo(tmp_path)
    a = next(h for h in parser.parse(_PATCH) if h.file_path.endswith("x.ts"))

    # WITHOUT resolution: the shared-symbol grounding can't connect B to A.
    hunks = parser.parse(_PATCH)
    _classify(hunks, RegexFactsProvider())
    b = next(h for h in hunks if h.file_path.endswith("y.ts"))
    a_id = next(h for h in hunks if h.file_path.endswith("x.ts")).id
    assert a_id not in b.wires

    # WITH resolution: B imports from the changed file x.ts → wires to A, stamped resolved.
    hunks = parser.parse(_PATCH)
    _classify(hunks, ResolvedFactsProvider(RegexFactsProvider(), repo))
    a_h = next(h for h in hunks if h.file_path.endswith("x.ts"))
    b = next(h for h in hunks if h.file_path.endswith("y.ts"))
    assert a_h.role == "core"
    assert a_h.id in b.wires
    assert a_h.id in b.resolved_wires


def test_resolved_wires_stamped_resolved_full_in_graph_ir(tmp_path):
    from src.core.graph_ir import Provenance, from_hunks
    repo = _repo(tmp_path)
    hunks = parser.parse(_PATCH)
    _classify(hunks, ResolvedFactsProvider(RegexFactsProvider(), repo))
    g = from_hunks(hunks)
    resolved = [e for e in g.edges if e.provenance == Provenance.RESOLVED_FULL]
    assert resolved and all(e.kind == "wires" for e in resolved)
