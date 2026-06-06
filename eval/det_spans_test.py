#!/usr/bin/env python3
"""Deterministic span/overlap gate — the regression test for the NON-LLM decomposition.

The LLM passes are covered by the stochastic reliability harness (eval/harness.py).
The DETERMINISTIC pass is a pure function of the diff text, so it is pinned here by
EXACT assertion instead — run before/after any change to the span machinery so a
"smarter" heuristic can't silently regress.

    .venv/bin/python eval/det_spans_test.py     # exits non-zero on any failure

Coverage:
  - leading_ambient_lines (Phase 1 import-peel): where the ambient header ends, across
    languages, plus the negatives (no anchor / whole-body ambient / starts-with-code).
  - _primary_symbol (seam label): Component over SCREAMING_CASE constant; enclosing
    recovered from @@ header AND from file-top body context.
  - _span_map (Phase 2 overlap): a core placed as a link sub-range into its sibling
    cores' seams, never into its own; the ambient-namesake filter; the link branch.
  - END-TO-END: parse -> classifier_det -> emit_seams_json, asserting a fused hunk
    emits environment+core blocks and a container core emits a sibling link block.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src import classifier_det, noise_filter, parser, renderer  # noqa: E402
from src.facts import HunkFacts, extract, leading_ambient_lines  # noqa: E402
from src.parser import Hunk  # noqa: E402

_FAILS = 0


def _check(name: str, ok: bool, detail: str = "") -> None:
    global _FAILS
    _FAILS += not ok
    line = f"  [{'ok ' if ok else 'FAIL'}] {name:42}"
    if detail and not ok:
        line += f"  {detail}"
    print(line)


def _mk(hid: str, body: str, file: str = "a.tsx", header: str = "", start: int = 1) -> Hunk:
    """A hunk from a BODY snippet (no @@ line). Lines beginning with a bare marker
    (`+`/`-`/space) keep it; otherwise the line is treated as added (`+`)."""
    lines = []
    for ln in body.split("\n"):
        lines.append(ln if ln[:1] in "+- " else "+" + ln)
    count = sum(1 for ln in lines if not ln.startswith("-"))
    text = f"@@ -{start},{count} +{start},{count} @@ {header}\n" + "\n".join(lines)
    return Hunk(id=hid, file_path=file, source_file=f"a/{file}", target_file=f"b/{file}",
                change_type="modify", section_header=header, text=text)


# --------------------------------------------------------------------------- Phase 1
def test_leading_ambient() -> None:
    print("=== leading_ambient_lines (Phase 1 import-peel) ===")

    # TS: directive + imports + blank, then a const/component → peel the header.
    ts = _mk("h", '"use client";\n\nimport { Badge } from "@ui/badge";\nimport Link from "next/link";\n'
                   '\nconst MAX = 7;\nexport default function Widget() {\n  if (x) return 1;\n}')
    _check("ts: directive+imports peel before const", leading_ambient_lines(ts) == 5,
           f"got {leading_ambient_lines(ts)} (want 5)")

    # Python: imports + blank, then a def.
    py = _mk("h", "import os\nfrom x import y\n\ndef foo():\n    return os.getcwd()", file="m.py")
    _check("py: imports peel before def", leading_ambient_lines(py) == 3,
           f"got {leading_ambient_lines(py)} (want 3)")

    # type-decl is ambient header too (no logic), then a function.
    td = _mk("h", "import { T } from './t';\ntype Props = { a: number };\n"
                  "export function f(p: Props) {\n  return p.a;\n}")
    _check("ts: type-decl counts as ambient header", leading_ambient_lines(td) == 2,
           f"got {leading_ambient_lines(td)} (want 2)")

    # NEGATIVE — starts with code: nothing to peel.
    code = _mk("h", "export function f() {\n  return 1;\n}")
    _check("neg: starts-with-code → 0", leading_ambient_lines(code) == 0)

    # NEGATIVE — whole body is imports (handled by flat env role, not a span).
    allimp = _mk("h", 'import a from "a";\nimport b from "b";')
    _check("neg: whole-body imports → 0", leading_ambient_lines(allimp) == 0)

    # NEGATIVE — only blanks/comments lead (no import/decl anchor) → not worth a span.
    cmt = _mk("h", "// a note\n\nexport function f() {\n  return 1;\n}")
    _check("neg: comment-only header (no anchor) → 0", leading_ambient_lines(cmt) == 0)


# --------------------------------------------------------------------------- seam label
def test_primary_symbol() -> None:
    print("=== _primary_symbol (seam label) ===")

    def label(defines, header="", text="x"):
        f = HunkFacts(defines=set(defines))
        h = _mk("h", text, header=header)
        return classifier_det._primary_symbol(f, h, set(defines))

    _check("Component preferred over SCREAMING_CASE const",
           label({"MAX_BADGES", "WebhookListItem"}) == "WebhookListItem")
    # File-top hunk: enclosing component is a CONTEXT line in the body, only the const is
    # an added define — recover the component from the body.
    body = ' "use client";\n+const MAX_BADGES = 7;\n export default function WebhookListItem() {'
    _check("file-top: enclosing recovered from body context",
           classifier_det._primary_symbol(HunkFacts(defines={"MAX_BADGES"}),
                                           _mk("h", body), set()) == "WebhookListItem")
    # Lowercase local define + an enclosing @@ Component → prefer the component.
    _check("enclosing @@ component over lowercase local",
           label({"readOnly"}, header="export const EventWebhooksTab = () => {") == "EventWebhooksTab")


# --------------------------------------------------------------------------- Phase 2
def test_span_map_overlap() -> None:
    print("=== _span_map (Phase 2 core→sibling overlap) ===")

    # coreChild defines WebhookVersionCTA; coreParent (big) renders <WebhookVersionCTA/>
    # and <WebhookForm/>; coreForm defines WebhookForm.
    child = _mk("h1", "export function WebhookVersionCTA() {\n  if (v) return 1;\n  return 2;\n}",
                file="cta.tsx")
    form = _mk("h2", "export function WebhookForm() {\n  if (q) return 1;\n  return 2;\n}",
               file="form.tsx")
    parent = _mk("h3", "export function ParentTab() {\n  return (\n    <div>\n"
                       "      <WebhookVersionCTA />\n      <WebhookForm />\n    </div>\n  );\n}",
                 file="parent.tsx")
    hunks = [child, form, parent]
    classifier_det.classify(hunks)
    # all three should be cores (each defines a referenced symbol / has logic)
    roles = {h.id: h.role for h in hunks}
    _check("setup: parent/child/form are cores", all(roles[i] == "core" for i in ("h1", "h2", "h3")),
           f"roles={roles}")

    _, core_out = renderer._span_map(hunks)
    placed = core_out.get("h3", {})
    _check("parent placed into BOTH sibling seams", set(placed) == {"h1", "h2"},
           f"got {sorted(placed)} (want ['h1','h2'])")
    _check("parent NOT placed into its own seam", "h3" not in placed)
    _check("children have no sibling placement (no outward refs)",
           "h1" not in core_out and "h2" not in core_out, f"core_out keys={sorted(core_out)}")

    # NEGATIVE — ambient namesake: two cores both define `Helper` → def_freq>1 → dropped,
    # so a body mentioning `Helper` does NOT wire either.
    a = _mk("h1", "export function Helper() {\n  if (x) return 1;\n  return 2;\n}", file="a.tsx")
    b = _mk("h2", "export function Helper() {\n  if (y) return 1;\n  return 2;\n}", file="b.tsx")
    user = _mk("h3", "export function Uses() {\n  if (z) return Helper();\n  return 0;\n}", file="c.tsx")
    hunks2 = [a, b, user]
    classifier_det.classify(hunks2)
    _, core_out2 = renderer._span_map(hunks2)
    _check("ambient namesake (def_freq>1) is not a sibling anchor", not core_out2.get("h3"),
           f"got {core_out2.get('h3')}")


# --------------------------------------------------------------------------- end-to-end
_E2E_DIFF = '''\
diff --git a/parent.tsx b/parent.tsx
--- a/parent.tsx
+++ b/parent.tsx
@@ -1,3 +1,12 @@
 "use client";
+import { Badge } from "@ui/badge";
+import { WebhookVersionCTA } from "./cta";
+
+export function ParentTab({ items }: Props) {
+  if (!items.length) {
+    return <Empty />;
+  }
+  return <div><WebhookVersionCTA /></div>;
+}
diff --git a/cta.tsx b/cta.tsx
--- a/cta.tsx
+++ b/cta.tsx
@@ -1,2 +1,6 @@
 import { useState } from "react";
+export function WebhookVersionCTA() {
+  const [v, setV] = useState(0);
+  if (v) return <span>{v}</span>;
+  return null;
+}
'''


def test_end_to_end() -> None:
    print("=== end-to-end: parse → classifier_det → emit_seams ===")
    hunks = parser.parse(_E2E_DIFF)
    remaining = noise_filter.classify(hunks)
    classifier_det.classify(remaining)
    emit = renderer.emit_seams_json(hunks)

    # collect (seam_id, label, role, start, end) placements per hunk id
    places: dict[str, list[tuple]] = {}
    for c in emit["clusters"]:
        for s in c["seams"]:
            for h in s["hunks"]:
                places.setdefault(h["id"], []).append((s["id"], s["label"], h["role"]))

    parent = next(h for h in hunks if h.file_path == "parent.tsx")
    cta = next(h for h in hunks if h.file_path == "cta.tsx")

    pp = places.get(parent.id, [])
    roles_in = lambda hid, seam: {r for sid, _, r in places.get(hid, []) if sid == seam}
    # Phase 1: the fused parent hunk (imports + component) emits an environment block
    # AND a core block in its OWN seam.
    own = parent.id
    _check("fused parent: env + core in own seam", roles_in(parent.id, own) == {"environment", "core"},
           f"got {roles_in(parent.id, own)}; all={pp}")
    # Phase 2: the parent ALSO appears as a link in the CTA sibling seam (overlap).
    _check("parent appears as link in CTA seam", "link" in roles_in(parent.id, cta.id),
           f"got placements={pp}")
    # The CTA core is no longer isolated — its seam now contains a link (the parent).
    cta_seam_roles = {r for _, _, r in places.get(cta.id, [])} | roles_in(parent.id, cta.id)
    _check("CTA seam has both core and link (not isolated)", {"core", "link"} <= cta_seam_roles,
           f"got {cta_seam_roles}")


def main() -> int:
    test_leading_ambient()
    test_primary_symbol()
    test_span_map_overlap()
    test_end_to_end()
    print(f"\n{'=' * 44}\n{_FAILS} failure(s)")
    return 1 if _FAILS else 0


if __name__ == "__main__":
    raise SystemExit(main())
