#!/usr/bin/env python3
"""Self-contained tests for the tree-sitter facts producer (src/facts_treesitter.py).

Uses DictFileSource fixtures (full file + a synthetic diff over it) so line numbers align
by construction and assertions are exact — no need to reconstruct real post-image files.

Proves:
  1. WIN     — AST masking excludes a MULTI-LINE string's decoy keywords from `decisions`,
               which the regex `_mask_code` (per-line, no cross-line string state) cannot.
  2. ANCHOR  — on clean code (no comments/strings) tree-sitter ≡ regex (the equivalence
               methodology that will later pin tree-sitter ≡ VS Code).
  3. FALLBACK— a hunk whose file is absent degrades to the exact regex result.
  4. GUARD   — a file that doesn't match the diff (wrong commit) is rejected → regex.

Skips cleanly if `tree-sitter-language-pack` isn't installed.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src import facts_treesitter as ts, parser
from src.facts import DictFileSource, RegexFactsProvider


def _hunk(diff: str):
    hs = parser.parse(diff)
    assert len(hs) == 1, f"expected 1 hunk, got {len(hs)}"
    return hs[0]


# --- fixture 1: multi-line string with decoy keywords (the tree-sitter win) ---------
_PY_FILE = (
    'def handler(req):\n'
    '    doc = """\n'
    '    if you return this for a while, switch context\n'
    '    call ghostCall() and fakeDefine\n'
    '    """\n'
    '    if req.ok:\n'
    '        return realCall(req.id)\n'
    '    return None\n'
)
_PY_DIFF = (
    "--- /dev/null\n+++ b/app/svc.py\n@@ -0,0 +1,8 @@\n"
    + "".join("+" + ln + "\n" for ln in _PY_FILE.splitlines())
)

# --- fixture 2: clean code, no comments/strings (the equivalence anchor) -------------
_CLEAN_FILE = (
    "export function compute(a, b) {\n"
    "  if (a > b) {\n"
    "    return helperCall(a);\n"
    "  }\n"
    "  return b;\n"
    "}\n"
)
_CLEAN_DIFF = (
    "--- /dev/null\n+++ b/app/clean.ts\n@@ -0,0 +1,6 @@\n"
    + "".join("+" + ln + "\n" for ln in _CLEAN_FILE.splitlines())
)


def main() -> int:
    if not ts.available():
        print("  [skip] tree-sitter not installed — install tree_sitter "
              "tree-sitter-language-pack to run these tests")
        return 0

    rx = RegexFactsProvider()
    fails = 0

    # 1. WIN: multi-line string decoys excluded from decisions by the AST mask.
    h = _hunk(_PY_DIFF)
    tsp = ts.TreeSitterFactsProvider(DictFileSource({"app/svc.py": _PY_FILE}))
    tf, rf = tsp.facts([h])[h.id], rx.facts([h])[h.id]
    # Real decisions: `if req.ok` + two `return`s = 3. Regex also counts the decoy line
    # inside the triple-quoted string (it has no cross-line string state); tree-sitter
    # masks the whole string node, so it counts fewer.
    win = tf.decisions == 3 and rf.decisions > tf.decisions
    print(f"  [{'ok ' if win else 'FAIL'}] multiline-string decoy excluded "
          f"(treesitter decisions={tf.decisions}, regex={rf.decisions}, expect ts=3 < regex)")
    fails += not win

    # 2. ANCHOR: clean code → identical facts (tree-sitter ≡ regex).
    h2 = _hunk(_CLEAN_DIFF)
    tsp2 = ts.TreeSitterFactsProvider(DictFileSource({"app/clean.ts": _CLEAN_FILE}))
    eq = tsp2.facts([h2])[h2.id] == rx.facts([h2])[h2.id]
    print(f"  [{'ok ' if eq else 'FAIL'}] clean code: tree-sitter ≡ regex facts")
    fails += not eq

    # 3. FALLBACK: file absent → exact regex result.
    tsp3 = ts.TreeSitterFactsProvider(DictFileSource({}))  # no files
    fb = tsp3.facts([h])[h.id] == rx.facts([h])[h.id]
    print(f"  [{'ok ' if fb else 'FAIL'}] missing file → regex fallback")
    fails += not fb

    # 4. GUARD: file present but does NOT contain the diff's added lines → reject → regex.
    tsp4 = ts.TreeSitterFactsProvider(DictFileSource({"app/svc.py": "totally\nunrelated\nfile\n"}))
    guard = tsp4.facts([h])[h.id] == rx.facts([h])[h.id]
    print(f"  [{'ok ' if guard else 'FAIL'}] misaligned file (wrong commit) → regex fallback")
    fails += not guard

    print("\n" + "=" * 40)
    print(f"{fails} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
