"""Text renderers (llm markdown + ascii tree) over the classified seam model. Hermetic."""
from __future__ import annotations

from src.diff import classifier_det, parser, report_text
from src.diff.facts import RegexFactsProvider
from src.diff.facts_resolve import ResolvedFactsProvider

_PATCH = """\
diff --git a/packages/lib/x.ts b/packages/lib/x.ts
--- a/packages/lib/x.ts
+++ b/packages/lib/x.ts
@@ -1,2 +1,3 @@
 const a = 1;
+export const CAL_URL = compute();
 const b = 2;
"""


def _classify(patch=_PATCH, provider=None):
    hunks = parser.parse(patch)
    classifier_det.classify(hunks, facts_provider=provider or RegexFactsProvider())
    return hunks


def test_llm_format_has_structure_and_legend():
    out = report_text.render(_classify(), style="llm")
    assert out.startswith("# Seam — diff decomposition")
    assert "Legend:" in out and "## " in out and "### " in out
    # role tag + a file:line location appear as a markdown list item
    assert "- core" in out or "- env " in out
    assert "packages/lib/x.ts" in out


def test_ascii_format_uses_tree_glyphs():
    out = report_text.render(_classify(), style="ascii")
    assert out.startswith("Seam · ")
    assert "◆ core" in out          # legend glyphs
    assert "├─" in out or "└─" in out  # box-drawing tree
    # ascii uses basenames, not full paths, in the tree body
    assert "x.ts:" in out


def test_blast_radius_consumers_render(tmp_path):
    (tmp_path / "packages" / "lib").mkdir(parents=True)
    (tmp_path / "apps").mkdir()
    (tmp_path / "packages" / "lib" / "package.json").write_text('{"name": "@demo/lib"}\n')
    (tmp_path / "packages" / "lib" / "x.ts").write_text("export const CAL_URL = '';\n")
    (tmp_path / "apps" / "consumer.ts").write_text(
        'import { CAL_URL } from "@demo/lib/x";\nexport const u = CAL_URL;\n')
    repo = str(tmp_path)
    hunks = _classify(provider=ResolvedFactsProvider(RegexFactsProvider(), repo))
    out = report_text.render(hunks, style="llm", repo=repo, blast_radius=True)
    assert "consumer outside diff" in out or "consumers outside diff" in out
    assert "consumer.ts" in out          # the consuming file (only in a real blast-radius line)
    # off by default → no blast-radius line (the consuming file is absent; the legend's ⇲ stays)
    assert "consumer.ts" not in report_text.render(hunks, style="llm", repo=repo, blast_radius=False)


def test_unknown_style_defaults_to_llm():
    out = report_text.render(_classify(), style="whatever")
    assert out.startswith("# Seam")


# A diff that includes a TEST hunk — exercises the tests/noise section (and `_loc`, which a
# core/link-only fixture never reaches). Regression for `Hunk` having no `.start` attribute.
_PATCH_WITH_TEST = _PATCH + """\
diff --git a/x.test.ts b/x.test.ts
--- a/x.test.ts
+++ b/x.test.ts
@@ -0,0 +1,2 @@
+import { CAL_URL } from "./x";
+test("url", () => { expect(CAL_URL).toBeDefined(); });
"""


def test_tests_section_renders_with_location():
    hunks = _classify(_PATCH_WITH_TEST)
    assert any(h.role == "test" for h in hunks)        # the .test.ts hunk is a test role
    for style in ("llm", "ascii"):
        out = report_text.render(hunks, style=style)
        assert "Tests (" in out and "x.test.ts:" in out  # the section + a file:line location
