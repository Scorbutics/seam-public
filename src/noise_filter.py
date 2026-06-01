"""Deterministic noise pre-filter — runs before the LLM.

§9 explicitly allows heuristics + LLM, and noise's trust mechanism is literally
"confirm it really is noise", which suits a rule far better than a model. Anything
this catches never reaches the classifier (cheaper, and more trustworthy for the
one role where determinism matters).

Caught here:
  - binary changes (cannot be reviewed as text; trust delegated to the consumer)
  - pure renames with no content change
  - whitespace / formatting / indentation-only hunks, INCLUDING reflow (a line
    re-wrapped across multiple lines with the same tokens)
"""

from __future__ import annotations

import re

from .parser import Hunk

_WS = re.compile(r"\s+")


def _strip_all_ws(s: str) -> str:
    return _WS.sub("", s)


def _is_whitespace_or_reflow(hunk: Hunk) -> bool:
    """True if the added and removed sides carry the SAME tokens, differing only in
    whitespace, indentation, or where the line breaks fall (reflow).

    We compare the two sides as a whole, IN ORDER, with all whitespace removed —
    so a one-liner reflowed onto many lines (or vice-versa) still matches. This is
    deliberately order-preserving: unlike a sorted compare, a genuine REORDER of
    lines is NOT treated as noise (a reorder can change behaviour).

    Requires content on both sides — a pure add or pure delete is a real change.
    """
    added, removed = [], []
    for line in hunk.text.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            added.append(line[1:])
        elif line.startswith("-"):
            removed.append(line[1:])
    if not added or not removed:
        return False
    # Concatenate each side in order, then drop ALL whitespace. Equal ⇒ the change
    # is only line-breaks / indentation / spacing.
    return _strip_all_ws("".join(added)) == _strip_all_ws("".join(removed))


def classify(hunks: list[Hunk]) -> list[Hunk]:
    """Mark obvious-noise hunks in place; return the hunks still needing the LLM."""
    remaining: list[Hunk] = []
    for h in hunks:
        if h.is_binary:
            h.role, h.rationale = "noise", "binary change — not reviewable as text"
        elif h.is_rename and h.change_type == "rename" and "@@" not in h.text:
            h.role, h.rationale = "noise", "pure rename, no content change"
        elif _is_whitespace_or_reflow(h):
            h.role, h.rationale = "noise", "whitespace / formatting / reflow only"
        else:
            remaining.append(h)
    return remaining
