"""Text renderers for diff seams — `llm` (markdown, for feeding a model) and `ascii` (a
box-drawing tree for the CLI). PURE FORMATTING over the same assembled model the HTML report
and `--emit-seams` consume (`seams._build_clusters` + `seams.context_maps`); no new
classification. The two styles share the per-hunk note + per-seam status builders and differ
only in glyphs/layout/legend.

Primary axis is the INTENT CLUSTER → SEAM → hunk (in file,line order), matching every other
surface: inside one seam you read the core and the hunks that wire it, adjacent. Honesty
markers (uncertain role, isolated core, dangling link) and the codebase-context overlays
(blast-radius consumers, external coupling, A→B rewire) are carried through verbatim.
"""
from __future__ import annotations

import os
from collections import Counter

from . import seams
from .parser import Hunk
from .subgroup import subgroup_seams

# Role glyphs (ascii style) and the fixed-width tag (both styles, so columns line up).
_ROLE_GLYPH = {"core": "◆", "link": "→", "environment": "∙", "test": "✓", "noise": "·"}
_ROLE_TAG = {"core": "core", "link": "link", "environment": "env ", "test": "test", "noise": "noise"}


def render(hunks: list[Hunk], *, style: str = "llm", repo: str | None = None,
           blast_radius: bool = False) -> str:
    """Render the classified `hunks` as text. `style`: 'llm' (markdown) or 'ascii' (tree)."""
    clusters, _ = seams._build_clusters(hunks, repo)
    conf, ext, refs, rewire, cons = seams.context_maps(hunks, repo, blast_radius)
    by_id = {h.id: h for h in hunks}
    seam_label = {s["id"]: (s["label"] or s["id"]) for cl in clusters for s in cl["seams"]}
    ctx = _Ctx(by_id, seam_label, ext, rewire, cons)
    return (_render_ascii if style == "ascii" else _render_llm)(hunks, clusters, ctx)


class _Ctx:
    """The shared per-hunk lookups a note line needs."""
    def __init__(self, by_id, seam_label, ext, rewire, cons):
        self.by_id, self.seam_label = by_id, seam_label
        self.ext, self.rewire, self.cons = ext, rewire, cons


# --------------------------------------------------------------------------- shared fragments
def _counts(hunks: list[Hunk], clusters: list[dict]) -> str:
    roles = Counter(h.role for h in hunks)
    n_seams = sum(c["n_seams"] for c in clusters)
    parts = "  ".join(f"{_ROLE_TAG[r].strip()} {roles[r]}" for r in
                      ("core", "link", "environment", "test", "noise") if roles.get(r))
    return (f"{len(hunks)} hunks → {len(clusters)} clusters · {n_seams} seams · "
            f"{roles.get('core', 0)} cores  (roles: {parts})")


def _seam_flags(s: dict) -> list[str]:
    """Honesty/status flags for a seam header: tested, uncertain, the verification warnings."""
    flags: list[str] = []
    if s.get("tested"):
        flags.append("tested")
    elif s.get("untested"):
        flags.append("⚠ untested")
    if s.get("uncertain"):
        flags.append(f"~ uncertain {int(round(s.get('confidence', 1) * 100))}%")
    v = s.get("verification", {})
    if v.get("link_only"):
        flags.append("link-only")
    for w in v.get("warnings", []):
        flags.append(f"⚠ {w['kind']}")
    if s.get("shares_with"):
        flags.append("↔ " + ",".join(s["shares_with"]))
    return flags


def _consumer_note(cons_list: list[dict]) -> str:
    """⇲ N consumers outside the diff (resolved/suggested split) + a few basenames."""
    n = len(cons_list)
    res = sum(1 for c in cons_list if c.get("status") == "resolved")
    sug = n - res
    split = (f" ({res} resolved" + (f", {sug} suggested" if sug else "") + ")") if res else " (suggested)"
    names: list[str] = []
    for c in cons_list:
        b = os.path.basename(c["file"])
        if b not in names:
            names.append(b)
        if len(names) >= 3:
            break
    more = " …" if n > len(names) else ""
    return f"⇲ {n} consumer{'s' if n != 1 else ''} outside diff{split}: " + ", ".join(names) + more


def _note(h: Hunk, ctx: _Ctx, current_seam: str | None = None) -> str:
    """The per-hunk Rich note: wiring (to OTHER seams) · rationale · rewire · external
    coupling · blast radius. `current_seam` is dropped from the wiring list (it's redundant
    with the seam this hunk is already shown under)."""
    parts: list[str] = []
    if h.role == "core" and h.seam_label:
        parts.append(f"defines {h.seam_label}")
    wires = [w for w in (h.wires or []) if w != current_seam]
    if wires:                                       # the OTHER seam(s) this hunk also wires
        sugg = set(getattr(h, "suggested_wires", ()) or ())   # ungrounded (LLM) → faint "~label"
        labels = [("~" + ctx.seam_label.get(w, w)) if w in sugg else ctx.seam_label.get(w, w)
                  for w in wires]
        parts.append("wires: " + ", ".join(labels[:4]) + (" …" if len(labels) > 4 else ""))
    elif h.role != "core" and h.rationale:          # no wiring → the reason it's here (not contradictory)
        parts.append(h.rationale.split("—", 1)[-1].strip() if "—" in h.rationale else h.rationale)
    rw = ctx.rewire.get(h.id)
    if rw and rw.get("removed") and rw.get("added"):
        parts.append("↻ " + "/".join(rw["removed"]) + " → " + "/".join(rw["added"]))
    if ctx.ext.get(h.id):                           # unwired link/env → outside-diff coupling
        parts.append("→ " + ", ".join(ctx.ext[h.id][:2]))
    if ctx.cons.get(h.id):
        parts.append(_consumer_note(ctx.cons[h.id]))
    return "  ·  ".join(parts)


def _loc(h: Hunk, *, basename: bool) -> str:
    f = os.path.basename(h.file_path) if basename else h.file_path
    start, _ = seams._hunk_line_span(h)          # new-side start line from the @@ header
    return f"{f}:{start}" if start else f


# --------------------------------------------------------------------------- llm (markdown)
_LEGEND_LLM = (
    "Legend: a SEAM = one technical intent (≥1 core + the hunks that wire it). "
    "core = new logic/decisions · link = wiring · env = ambient support · test = verification. "
    "\"wires: …\" connects seams · ⚠ = verify · ~ = uncertain role · ⇲ = consumers outside the diff."
)


def _seam_md(s: dict, ctx: _Ctx, prefix: str) -> list[str]:
    """One seam as markdown at the given heading level (### flat, #### under a sub-group)."""
    flags = _seam_flags(s)
    head = f"{prefix} {s['id']} · {s['label'] or s['id']}"
    if flags:
        head += " — " + " · ".join(flags)
    lines = [head]
    for b in s["blocks"]:
        h = _block_hunk(b, ctx)
        note = _note_for_block(b, h, ctx, s["id"])
        line = f"- {_ROLE_TAG.get(b['role'], b['role']):<4}  {_loc_block(b, basename=False)}"
        lines.append(line + (f"   {note}" if note else ""))
    lines.append("")
    return lines


def _render_llm(hunks: list[Hunk], clusters: list[dict], ctx: _Ctx) -> str:
    out: list[str] = ["# Seam — diff decomposition", _counts(hunks, clusters), "", _LEGEND_LLM, ""]
    for cl in clusters:
        out.append(f"## {cl['id']} · {cl['intent']}")
        sub = subgroup_seams(cl["seams"])            # altitude mid-level (None → render flat)
        if sub:
            by_id = {s["id"]: s for s in cl["seams"]}
            for grp in sub:
                out.append(f"### ▸ {grp['label']}  ({len(grp['seamIds'])} seam{"s" if len(grp["seamIds"])!=1 else ""})")
                for sid in grp["seamIds"]:
                    out.extend(_seam_md(by_id[sid], ctx, "####"))
        else:
            for s in cl["seams"]:
                out.extend(_seam_md(s, ctx, "###"))
    _append_tests_noise(out, hunks, ctx, markdown=True)
    return "\n".join(out).rstrip() + "\n"


# --------------------------------------------------------------------------- ascii (tree)
_LEGEND_ASCII = "◆ core   → link   ∙ env   ✓ test      ⚠ verify   ~ uncertain   ⇲ outside-diff"


def _seam_ascii(s: dict, ctx: _Ctx, prefix: str, is_last: bool) -> list[str]:
    """One seam as an ascii subtree, indented by `prefix` (so it can nest under a sub-group)."""
    branch, cont = ("└─", "  ") if is_last else ("├─", "│ ")
    flags = _seam_flags(s)
    head = f"{prefix}{branch} ▣ {s['id']}  {s['label'] or s['id']}"
    if flags:
        head += "    " + " · ".join(flags)
    lines = [head]
    blocks = s["blocks"]
    for bi, b in enumerate(blocks):
        b_branch = "└─" if bi == len(blocks) - 1 else "├─"
        h = _block_hunk(b, ctx)
        glyph = _ROLE_GLYPH.get(b["role"], "·")
        note = _note_for_block(b, h, ctx, s["id"])
        lines.append(f"{prefix}{cont} {b_branch} {glyph} {_ROLE_TAG.get(b['role'], b['role'])} "
                     f"{_loc_block(b, basename=True)}" + (f"   {note}" if note else ""))
    return lines


def _render_ascii(hunks: list[Hunk], clusters: list[dict], ctx: _Ctx) -> str:
    out: list[str] = [f"Seam · {_counts(hunks, clusters)}", _LEGEND_ASCII, ""]
    for cl in clusters:
        out.append(f"◆ {cl['id']}  {cl['intent']}")
        sub = subgroup_seams(cl["seams"])            # altitude mid-level (None → render flat)
        if sub:
            by_id = {s["id"]: s for s in cl["seams"]}
            for gi, grp in enumerate(sub):
                g_branch, g_cont = ("└─", "   ") if gi == len(sub) - 1 else ("├─", "│  ")
                out.append(f"{g_branch} ▸ {grp['label']}  ({len(grp['seamIds'])} seam{"s" if len(grp["seamIds"])!=1 else ""})")
                sids = grp["seamIds"]
                for si, sid in enumerate(sids):
                    out.extend(_seam_ascii(by_id[sid], ctx, g_cont, si == len(sids) - 1))
        else:
            seams_list = cl["seams"]
            for si, s in enumerate(seams_list):
                out.extend(_seam_ascii(s, ctx, "", si == len(seams_list) - 1))
        out.append("")
    _append_tests_noise(out, hunks, ctx, markdown=False)
    return "\n".join(out).rstrip() + "\n"


# --------------------------------------------------------------------------- block helpers
def _block_hunk(b: dict, ctx: _Ctx) -> Hunk:
    return ctx.by_id[b["hid"]]


def _loc_block(b: dict, *, basename: bool) -> str:
    f = os.path.basename(b["file"]) if basename else b["file"]
    return f"{f}:{b['start']}" if b.get("start") else f


def _note_for_block(b: dict, h: Hunk, ctx: _Ctx, seam_id: str) -> str:
    """A block renders with its EFFECTIVE role (a core placed in a sibling seam shows as link),
    so build the note from the block's role but the hunk's wiring/context."""
    note = _note(h, ctx, current_seam=seam_id)
    # If the block's role differs from the hunk's flat role (overlap placement), prefix it.
    if b["role"] != h.role:
        note = (f"(here: {b['role']}) " + note).strip()
    return note


def _append_tests_noise(out: list[str], hunks: list[Hunk], ctx: _Ctx, *, markdown: bool) -> None:
    tests = [h for h in hunks if h.role == "test"]
    noise = [h for h in hunks if h.role == "noise"]
    if tests:
        out.append(f"## Tests ({len(tests)}) — skim" if markdown else f"✓ Tests ({len(tests)}) — skim")
        for h in tests:
            covers = ("covers " + ", ".join(ctx.seam_label.get(w, w) for w in h.wires)) if h.wires else ""
            out.append(f"- {_loc(h, basename=not markdown)}" + (f"   {covers}" if covers else ""))
        out.append("")
    if noise:
        out.append(f"## Noise ({len(noise)}) — skip" if markdown else f"· Noise ({len(noise)}) — skip")
        for h in noise:
            out.append(f"- {_loc(h, basename=not markdown)}")
        out.append("")
