"""Parse a unified diff into hunks — the unit of decomposition.

Thin wrapper over `unidiff`. Each hunk gets a stable id (h1, h2, …) so the
classifier can label by id and the renderer can regroup without re-parsing.
We also retain enough header info per hunk to reconstruct a valid mini-diff for
diff2html when hunks are regrouped by role.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields

from unidiff import PatchSet


@dataclass
class Hunk:
    id: str
    file_path: str           # display path (target, or source for deletions)
    source_file: str         # e.g. "a/foo.py" or "/dev/null"
    target_file: str         # e.g. "b/foo.py" or "/dev/null"
    change_type: str         # add | delete | rename | modify | binary
    section_header: str      # text after the @@ marker (may be empty)
    text: str                # full hunk text incl. the @@ line
    is_rename: bool = False
    is_binary: bool = False
    # filled in later stages:
    role: str | None = None
    rationale: str = ""
    group: str = ""          # intent-cluster id, e.g. "g1" (empty for noise)
    intent: str = ""         # short human label of the cluster's intent
    seam: str = ""           # for a CORE: the seam id it anchors, e.g. "s1"
    seam_label: str = ""     # short human label of the seam (the wiring), set on the core
    wires: list[str] = field(default_factory=list)
    # for a LINK/environment hunk: the seam id(s) of the core(s) it wires. A link
    # may wire several cores (many-to-many), so it appears in several seams; an
    # empty list is a dangling link (wires something outside the diff).

    def header_line(self) -> str:
        """First line of the hunk (the @@ -.. +.. @@ marker)."""
        return self.text.splitlines()[0] if self.text else ""


_HUNK_FIELDS = {f.name for f in fields(Hunk)}


def hunks_to_json(hunks: list[Hunk]) -> str:
    """Serialize fully-labeled hunks — the post-classification INTERMEDIATE STATE.

    This is the artifact between the (expensive, LLM-driven) classify pass and the
    renderer: dumping it lets a report be regenerated, or the renderer iterated on,
    WITHOUT re-running the classifier.
    """
    return json.dumps([asdict(h) for h in hunks], indent=2)


def hunks_from_json(text: str) -> list[Hunk]:
    """Rebuild hunks from `hunks_to_json` output, ignoring unknown keys so older
    dumps still load if the dataclass gains fields."""
    return [Hunk(**{k: v for k, v in d.items() if k in _HUNK_FIELDS})
            for d in json.loads(text)]


def _display_path(pf) -> str:
    """Best human-facing path for a patched file."""
    if pf.target_file and pf.target_file != "/dev/null":
        return pf.target_file[2:] if pf.target_file.startswith("b/") else pf.target_file
    if pf.source_file and pf.source_file != "/dev/null":
        return pf.source_file[2:] if pf.source_file.startswith("a/") else pf.source_file
    return pf.path or "<unknown>"


def _change_type(pf) -> str:
    if getattr(pf, "is_binary_file", False):
        return "binary"
    if pf.is_added_file:
        return "add"
    if pf.is_removed_file:
        return "delete"
    if pf.is_rename:
        return "rename"
    return "modify"


def parse(diff_text: str) -> list[Hunk]:
    """Parse unified-diff text into a flat, ordered list of Hunk objects."""
    patch = PatchSet.from_string(diff_text)
    hunks: list[Hunk] = []
    counter = 0

    for pf in patch:
        change_type = _change_type(pf)
        display = _display_path(pf)

        # Binary files have no textual hunks — represent as a single placeholder
        # so they still surface in the report (they bucket to noise downstream).
        if change_type == "binary" or (len(pf) == 0):
            counter += 1
            if change_type == "binary":
                note = f"binary change: {display}"
            elif pf.is_rename:
                src = pf.source_file[2:] if pf.source_file.startswith("a/") else pf.source_file
                note = f"pure rename: {src} → {display}"
            else:
                note = f"contentless change: {display}"
            hunks.append(
                Hunk(
                    id=f"h{counter}",
                    file_path=display,
                    source_file=pf.source_file,
                    target_file=pf.target_file,
                    change_type=change_type if change_type == "binary" else "rename",
                    section_header="",
                    text=note,
                    is_rename=pf.is_rename,
                    is_binary=(change_type == "binary"),
                )
            )
            continue

        for h in pf:
            counter += 1
            hunks.append(
                Hunk(
                    id=f"h{counter}",
                    file_path=display,
                    source_file=pf.source_file,
                    target_file=pf.target_file,
                    change_type=change_type,
                    section_header=(h.section_header or "").strip(),
                    text=str(h),
                    is_rename=pf.is_rename,
                    is_binary=False,
                )
            )

    return hunks
