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
class Span:
    """A contiguous role-region *within* a single hunk (Direction C).

    A hunk often fuses >1 role (e.g. import/boilerplate churn glued by proximity
    to new logic). Rather than mechanically splitting the hunk — which the census
    showed explodes/destabilizes cores & seams — we let the classifier carry the
    sub-roles here while the HUNK stays the single seam anchor. So `spans` recovers
    fusion without fragmenting the grouping layer.

    `lines` is a 1-based inclusive index range over the hunk's BODY lines (the
    lines after the @@ header, as numbered in the classifier prompt), e.g. "3-9".
    A core span carries seam/seam_label; a link/environment span carries wires.
    """
    role: str
    lines: str = ""          # "start-end" over the hunk body, 1-based inclusive
    rationale: str = ""
    seam: str = ""           # core span: the seam id it anchors
    seam_label: str = ""     # core span: short label of the wiring
    wires: list[str] = field(default_factory=list)  # link/env span: seam id(s) wired


@dataclass
class Placement:
    """One rendered sub-region of a hunk: this hunk participates in seam `seam` with role
    `role` over the NEW-SIDE line range [start, end] (a sub-range of the hunk, overlap
    allowed). Computed by the engine (classifier_det.assign_spans) — the OVERLAP model:
    a hunk's meaning is SEAM-DEPENDENT, so the same lines can be `core` in their home seam
    AND `link` in a sibling's (a container rendering a sibling component). This is a part
    of the classified state (dumped/emitted), so the renderer only READS it.

    Two kinds:
      - seam != ""  → an attachment into THAT seam (a link/env split per wired core, or a
        core placed as a `link` sub-range into a sibling core's seam). `role` is the role
        played IN that seam.
      - seam == ""  → the leading-ambient HEADER peel of the hunk's OWN placement (role is
        always "environment"): the import/decl block that opens a fused hunk, split off so
        it doesn't read as part of the logic below. [start, end] is the header's range.
    """
    seam: str
    role: str
    start: int = 0           # new-side file line (inclusive)
    end: int = 0             # new-side file line (inclusive)


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
    role_confidence: float = 1.0  # share of self-consistency votes agreeing on this
                                  # role (1.0 = single pass / unanimous); low = the
                                  # model was genuinely split → surface as "uncertain"
    rationale: str = ""
    group: str = ""          # intent-cluster id, e.g. "g1" (empty for noise)
    intent: str = ""         # short human label of the cluster's intent
    seam: str = ""           # for a CORE: the seam id it anchors, e.g. "s1"
    seam_label: str = ""     # short human label of the seam (the wiring), set on the core
    wires: list[str] = field(default_factory=list)
    # for a LINK/environment hunk: the seam id(s) of the core(s) it wires. A link
    # may wire several cores (many-to-many), so it appears in several seams; an
    # empty list is a dangling link (wires something outside the diff).
    spans: list[Span] = field(default_factory=list)
    # Direction C: per-role sub-regions within this hunk. EMPTY for a mono-role
    # hunk (use the flat role/seam/wires above). When non-empty the hunk is fused
    # and `spans` carries the truth; the flat fields above are kept in sync as a
    # summary (role = the core span's role if any, seam from the core span, wires
    # = union over spans) so existing role-keyed code keeps working.
    placements: list[Placement] = field(default_factory=list)
    # The OVERLAP / span-decomposition (engine-computed; see classifier_det.assign_spans).
    # Per-seam sub-range attachments + the leading-ambient header peel — the renderer reads
    # these to split a hunk across seams (a core also wiring its siblings) instead of
    # recomputing. ADDITIVE to the flat fields, so the role/wiring golds are unaffected.
    resolved_wires: list[str] = field(default_factory=list)
    # Subset of `wires` drawn from a REAL resolved import (ResolvedFactsProvider), not the
    # in-diff shared-symbol heuristic. `graph_ir.from_hunks` stamps these RESOLVED_FULL (the
    # codebase confirms the edge) vs HEUR for the rest. Empty unless --resolver + --repo are set.

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


_SPAN_FIELDS = {f.name for f in fields(Span)}
_PLACEMENT_FIELDS = {f.name for f in fields(Placement)}


def hunks_from_json(text: str) -> list[Hunk]:
    """Rebuild hunks from `hunks_to_json` output, ignoring unknown keys so older
    dumps still load if the dataclass gains fields."""
    hunks: list[Hunk] = []
    for d in json.loads(text):
        kw = {k: v for k, v in d.items() if k in _HUNK_FIELDS}
        kw["spans"] = [Span(**{k: v for k, v in s.items() if k in _SPAN_FIELDS})
                       for s in d.get("spans", []) if isinstance(s, dict)]
        kw["placements"] = [Placement(**{k: v for k, v in p.items() if k in _PLACEMENT_FIELDS})
                            for p in d.get("placements", []) if isinstance(p, dict)]
        hunks.append(Hunk(**kw))
    return hunks


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
