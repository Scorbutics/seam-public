"""Deterministic span/overlap gate — the regression suite for the NON-LLM decomposition.

The LLM passes are covered by the stochastic reliability harness (eval/harness.py).
The DETERMINISTIC pass is a pure function of the diff text, so it is pinned here by
EXACT assertion (pytest) instead — run before/after any change to the span machinery so
a "smarter" heuristic can't silently regress:

    .venv/bin/python -m pytest eval/test_det_spans.py -q

Coverage:
  - leading_ambient_lines (Phase 1 import-peel): where the ambient header ends, across
    languages, plus the negatives (no anchor / whole-body ambient / starts-with-code).
  - _primary_symbol (seam label): Component over SCREAMING_CASE constant; enclosing
    recovered from the @@ header AND from file-top body context.
  - _span_map (Phase 2 overlap): a core placed as a link sub-range into its sibling
    cores' seams, never into its own; the ambient-namesake filter.
  - END-TO-END: parse → classifier_det → emit_seams_json, asserting a fused hunk emits
    environment+core blocks and a container core emits a sibling link block (the overlap).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src.diff import classifier_det, noise_filter, parser, seams
from src.diff.facts import HunkFacts, leading_ambient_lines  # noqa: E402
from src.diff.parser import Hunk  # noqa: E402


def mk(hid: str, body: str, file: str = "a.tsx", header: str = "", start: int = 1) -> Hunk:
    """Build a Hunk from a BODY snippet (no @@ line). CONVENTION: every line is an ADDED
    line, indentation preserved, UNLESS it starts with an explicit `-` (removed) or `~`
    (context — the tilde is stripped and the line becomes a real context line). This
    avoids the trap that a space-indented code line looks like a diff context marker."""
    out: list[str] = []
    for ln in body.split("\n"):
        if ln.startswith("-"):
            out.append(ln)
        elif ln.startswith("~"):
            out.append(" " + ln[1:])
        else:
            out.append("+" + ln)
    new = sum(1 for ln in out if not ln.startswith("-"))
    old = sum(1 for ln in out if ln.startswith((" ", "-")))
    text = f"@@ -{start},{old} +{start},{new} @@ {header}".rstrip() + "\n" + "\n".join(out)
    return Hunk(id=hid, file_path=file, source_file=f"a/{file}", target_file=f"b/{file}",
                change_type="modify", section_header=header, text=text)


def _cores(*hunks: Hunk) -> dict[str, str]:
    """Classify a fresh hunk list deterministically and return {id: role}."""
    hs = list(hunks)
    classifier_det.classify(hs)
    return {h.id: h.role for h in hs}


# --------------------------------------------------------------------------- Phase 1
@pytest.mark.parametrize("name,body,file,want", [
    # directive + imports + blank, then a const/component → peel the 5-line header.
    ("ts-directive-imports",
     '"use client";\n\nimport { Badge } from "@ui/badge";\nimport Link from "next/link";\n\n'
     'const MAX = 7;\nexport default function Widget() {\n  if (x) return 1;\n}', "a.tsx", 5),
    # Python imports + blank, then a def.
    ("py-imports", "import os\nfrom x import y\n\ndef foo():\n    return os.getcwd()", "m.py", 3),
    # a pure type-decl is an ambient header line too (no logic), then a function.
    ("ts-type-decl",
     "import { T } from './t';\ntype Props = { a: number };\nexport function f(p: Props) {\n"
     "  return p.a;\n}", "a.tsx", 2),
    # NEGATIVE: starts with code → nothing to peel.
    ("neg-starts-with-code", "export function f() {\n  return 1;\n}", "a.tsx", 0),
    # NEGATIVE: whole body is imports → flat env role handles it, not a span.
    ("neg-all-imports", 'import a from "a";\nimport b from "b";', "a.tsx", 0),
    # NEGATIVE: only blanks/comments lead (no import/decl anchor) → not worth a span.
    ("neg-comment-only", "// a note\n\nexport function f() {\n  return 1;\n}", "a.tsx", 0),
])
def test_leading_ambient_lines(name, body, file, want):
    assert leading_ambient_lines(mk("h", body, file=file)) == want


# --------------------------------------------------------------------------- seam label
def _label(defines, header="", body="x"):
    return classifier_det._primary_symbol(HunkFacts(defines=set(defines)),
                                          mk("h", body, header=header), set(defines))


def test_label_prefers_component_over_screaming_const():
    assert _label({"MAX_BADGES", "WebhookListItem"}) == "WebhookListItem"


def test_label_recovers_enclosing_from_file_top_body():
    # File-top hunk: the component signature is a CONTEXT line in the body; only the const
    # is an added define. The label must still name the component.
    body = '~"use client";\nconst MAX_BADGES = 7;\n~export default function WebhookListItem() {'
    got = classifier_det._primary_symbol(HunkFacts(defines={"MAX_BADGES"}), mk("h", body), set())
    assert got == "WebhookListItem"


def test_label_prefers_enclosing_over_lowercase_local():
    assert _label({"readOnly"}, header="export const EventWebhooksTab = () => {") == "EventWebhooksTab"


# --------------------------------------------------------------------------- Phase 2
def _siblings():
    child = mk("h1", "export function WebhookVersionCTA() {\n  if (v) return 1;\n  return 2;\n}", file="cta.tsx")
    form = mk("h2", "export function WebhookForm() {\n  if (q) return 1;\n  return 2;\n}", file="form.tsx")
    # Real logic (≥2 decisions) so ParentTab is a CORE that ALSO renders sibling cores —
    # the h8/EventWebhooksTab shape: a core whose meaning overlaps into its siblings' seams.
    parent = mk("h3", "export function ParentTab({ items }) {\n  if (!items.length) return null;\n"
                      "  if (items.error) throw items.error;\n  return (\n    <div>\n"
                      "      <WebhookVersionCTA />\n      <WebhookForm />\n    </div>\n  );\n}", file="parent.tsx")
    return child, form, parent


def test_phase2_core_placed_into_both_sibling_seams():
    child, form, parent = _siblings()
    hunks = [child, form, parent]
    assert _cores(*hunks) == {"h1": "core", "h2": "core", "h3": "core"}
    _, core_out = seams._span_map(hunks)
    assert set(core_out.get("h3", {})) == {"h1", "h2"}


def test_phase2_core_never_placed_into_own_seam():
    child, form, parent = _siblings()
    hunks = [child, form, parent]
    classifier_det.classify(hunks)
    _, core_out = seams._span_map(hunks)
    assert "h3" not in core_out.get("h3", {})


def test_phase2_leaf_cores_have_no_outward_placement():
    child, form, parent = _siblings()
    hunks = [child, form, parent]
    classifier_det.classify(hunks)
    _, core_out = seams._span_map(hunks)
    assert "h1" not in core_out and "h2" not in core_out


def test_engine_writes_core_sibling_placements_to_data_model():
    # The OVERLAP is engine state now: classify must write `placements` onto the core,
    # one `link` placement per sibling seam — readable WITHOUT the renderer.
    child, form, parent = _siblings()
    hunks = [child, form, parent]
    classifier_det.classify(hunks)
    p = next(h for h in hunks if h.id == "h3")
    sibling = {(pl.seam, pl.role) for pl in p.placements if pl.seam}
    assert sibling == {("h1", "link"), ("h2", "link")}, p.placements
    # leaf cores reference nothing outward → no seam-targeted placements
    assert not any(pl.seam for pl in next(h for h in hunks if h.id == "h1").placements)


def test_engine_writes_header_peel_placement():
    # A fused hunk (imports then logic) gets a header-peel placement: seam=="" (own
    # placement), role=="environment", over the leading import block.
    hunks = parser.parse(_E2E_DIFF)
    classifier_det.classify(noise_filter.classify(hunks))
    parent = next(h for h in hunks if h.file_path == "parent.tsx")
    peels = [pl for pl in parent.placements if not pl.seam]
    assert len(peels) == 1 and peels[0].role == "environment", parent.placements
    assert peels[0].start <= peels[0].end


def test_placements_survive_json_roundtrip():
    # Placements are part of the classified state, so --dump-classified / --from-classified
    # must preserve them (otherwise the renderer would silently lose the overlap on reload).
    hunks = parser.parse(_E2E_DIFF)
    classifier_det.classify(noise_filter.classify(hunks))
    reloaded = parser.hunks_from_json(parser.hunks_to_json(hunks))
    before = {h.id: [(p.seam, p.role, p.start, p.end) for p in h.placements] for h in hunks}
    after = {h.id: [(p.seam, p.role, p.start, p.end) for p in h.placements] for h in reloaded}
    assert before == after


def test_phase2_ambient_namesake_is_not_a_sibling_anchor():
    # Two cores both DEFINE `Helper` → def_freq>1 → ambient → a body mentioning Helper
    # must NOT wire either (else every namesake hairballs).
    a = mk("h1", "export function Helper() {\n  if (x) return 1;\n  return 2;\n}", file="a.tsx")
    b = mk("h2", "export function Helper() {\n  if (y) return 1;\n  return 2;\n}", file="b.tsx")
    user = mk("h3", "export function Uses() {\n  if (z) return Helper();\n  return 0;\n}", file="c.tsx")
    hunks = [a, b, user]
    classifier_det.classify(hunks)
    _, core_out = seams._span_map(hunks)
    assert not core_out.get("h3")


# --------------------------------------------------------------------------- end-to-end
_E2E_DIFF = """\
diff --git a/parent.tsx b/parent.tsx
--- a/parent.tsx
+++ b/parent.tsx
@@ -1,1 +1,10 @@
 "use client";
+import { Badge } from "@ui/badge";
+import { WebhookVersionCTA } from "./cta";
+
+export function ParentTab({ items }) {
+  if (!items.length) {
+    return <Empty />;
+  }
+  return <div><WebhookVersionCTA /></div>;
+}
diff --git a/cta.tsx b/cta.tsx
--- a/cta.tsx
+++ b/cta.tsx
@@ -1,1 +1,6 @@
 import { useState } from "react";
+export function WebhookVersionCTA() {
+  const [v, setV] = useState(0);
+  if (v) return <span>{v}</span>;
+  return null;
+}
"""


@pytest.fixture()
def e2e_emit():
    """Run the real pipeline and return the emit_seams_json payload + a path→id map."""
    hunks = parser.parse(_E2E_DIFF)
    classifier_det.classify(noise_filter.classify(hunks))
    emit = seams.emit_seams_json(hunks)
    ids = {h.file_path: h.id for h in hunks}
    return emit, ids


@pytest.fixture()
def e2e_placements(e2e_emit):
    """{hunk_id: [(seam_id, role), ...]} — every placement of every hunk."""
    emit, ids = e2e_emit
    places: dict[str, list[tuple[str, str]]] = {}
    for c in emit["clusters"]:
        for s in c["seams"]:
            for h in s["hunks"]:
                places.setdefault(h["id"], []).append((s["id"], h["role"]))
    return places, ids


def _roles_in(places, hid, seam):
    return {r for sid, r in places.get(hid, []) if sid == seam}


def test_e2e_fused_hunk_emits_env_and_core(e2e_placements):
    places, ids = e2e_placements
    parent = ids["parent.tsx"]
    # Phase 1: the fused parent (imports + component) shows env AND core in its own seam.
    assert _roles_in(places, parent, parent) == {"environment", "core"}


def test_e2e_core_overlaps_into_sibling_seam(e2e_placements):
    places, ids = e2e_placements
    parent, cta = ids["parent.tsx"], ids["cta.tsx"]
    # Phase 2: the parent ALSO appears as a link in the CTA sibling seam (overlap).
    assert "link" in _roles_in(places, parent, cta)


def test_e2e_sibling_seam_not_isolated(e2e_placements):
    places, ids = e2e_placements
    parent, cta = ids["parent.tsx"], ids["cta.tsx"]
    # The CTA core is no longer an isolated core — its seam now holds a core and a link.
    seam_roles = {r for _, r in places.get(cta, [])} | _roles_in(places, parent, cta)
    assert {"core", "link"} <= seam_roles


def test_e2e_overlap_ranges_intersect_for_gutter_split(e2e_emit):
    """The VS Code gutter draws a SPLIT bar where one hunk's lines carry >1 role. That
    only works if the emit places the SAME hunk with overlapping (file-line) ranges under
    different roles. Pin that contract: the container's core range must intersect its
    link range, so the extension's per-line role-set is {core, link} on the shared lines."""
    emit, ids = e2e_emit
    parent = ids["parent.tsx"]
    ranges_by_role: dict[str, list[tuple[int, int]]] = {}
    for c in emit["clusters"]:
        for s in c["seams"]:
            for h in s["hunks"]:
                if h["id"] == parent:
                    ranges_by_role.setdefault(h["role"], []).append((h["start"], h["end"]))
    assert "core" in ranges_by_role and "link" in ranges_by_role, ranges_by_role
    core_r = ranges_by_role["core"][0]
    overlaps = any(not (lr[1] < core_r[0] or lr[0] > core_r[1]) for lr in ranges_by_role["link"])
    assert overlaps, f"core {core_r} must intersect a link range {ranges_by_role['link']}"
