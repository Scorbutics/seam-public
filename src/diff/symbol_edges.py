"""Deterministic symbol-grounded signals — the FLOOR the LLM passes build on.

These are DERIVED signals computed from the language primitives in `lang`
(`_defs_refs`, `_diff_imports`, `_salient_symbols`, …). Seam wiring is a
grounding/tracing problem, not a reasoning one (measured: the LLM is high-precision
but recall-bound, and "thinking" can't recover a reference it lost track of). So we
pre-compute candidate edges and let the model CONFIRM/PRUNE them — turning a
hallucination-prone generate task into a reliable validate task.

A FLOOR, not a ceiling: informal couplings (wired by convention, not by a literal
symbol) are invisible here and stay the LLM's job. The language-specific extraction
lives entirely in `lang` — swap that for tree-sitter/LSP without touching this file.

  - candidate_wirings  — def<->use grounding for the classifier passes.
  - external_refs / external_coupling — wiring OUTSIDE the diff (§I boundary).
  - rewire_pairs       — the A->B rewire from a hunk's own -/+ lines (§I).
  - segment_link_by_core / resolve_alias — split a big link by core (§B spans).
"""
from __future__ import annotations

import re

from .lang import _defs_refs, _diff_imports, _module_root, _salient_symbols, _IDENT
from .parser import Hunk


def external_refs(hunks: list[Hunk]) -> dict[str, list[dict[str, str]]]:
    """{hunk_id: [{"symbol","source"}]} — imported symbols a hunk references that are
    defined NOWHERE in the diff. The thing it wires to lives OUTSIDE the change (the
    §I 'diff is not the codebase' boundary). Prefers workspace/scoped (@scope, ./rel)
    sources over ubiquitous runtime libs (react, next, ...): when a scoped/relative
    source is present, drop the bare-lib noise. These (symbol, source) pairs are what
    Layer 2's resolver looks up — where the symbol actually LIVES + its signature.
    Deterministic; no LLM."""
    imp = _diff_imports(hunks)
    new_vocab: set[str] = set().union(*(d for d, _ in (_defs_refs(h.text) for h in hunks))) \
        if hunks else set()
    out: dict[str, list[dict[str, str]]] = {}
    for h in hunks:
        _d, refs = _defs_refs(h.text)
        pairs = [(s, imp[s]) for s in sorted(refs) if s in imp and s not in new_vocab]
        scoped = [(s, src) for s, src in pairs if src and src[0] in "@."]
        chosen = scoped if scoped else pairs
        out[h.id] = [{"symbol": s, "source": src} for s, src in chosen]
    return out


def external_coupling(hunks: list[Hunk]) -> dict[str, list[str]]:
    """{hunk_id: external module ROOTS} — for the '→ @coss/ui' display label. Derived
    from external_refs (the (symbol, source) pairs), reduced to unique module roots."""
    return {hid: sorted({_module_root(r["source"]) for r in rs})
            for hid, rs in external_refs(hunks).items()}


# A crisp rewire is a SMALL swap; beyond this it's a wholesale rewrite (dozens of
# components swapped), which is not a useful "A->B" — the role + external coupling
# already say "this was migrated". Suppress those rather than spew symbol lists.
_REWIRE_MAX = 2


def rewire_pairs(hunks: list[Hunk]) -> dict[str, dict[str, list[str]]]:
    """Per hunk, the A->B REWIRE read straight from its own -/+ lines: meaningful
    subjects (call/member roots, JSX tags) REMOVED vs ADDED, with unchanged ones
    cancelled by set difference. {hunk_id: {"removed":[...], "added":[...]}}.

    Reported only for a SMALL SWAP — both sides non-empty AND each <= _REWIRE_MAX
    (something focused replaced something: `showToast` -> `toastManager`). A pure
    add/delete, or a wholesale rewrite (many symbols), yields empty/empty; those are
    conveyed by the role + external coupling. Layer 1: the §I 're-routes A->B'
    signal, deterministic, no codebase resolution."""
    out: dict[str, dict[str, list[str]]] = {}
    for h in hunks:
        rem_lines, add_lines = [], []
        for ln in h.text.splitlines():
            if ln.startswith("-") and not ln.startswith("---"):
                rem_lines.append(ln[1:])
            elif ln.startswith("+") and not ln.startswith("+++"):
                add_lines.append(ln[1:])
        rem_only = sorted(_salient_symbols(rem_lines) - _salient_symbols(add_lines))
        add_only = sorted(_salient_symbols(add_lines) - _salient_symbols(rem_lines))
        crisp = rem_only and add_only and len(rem_only) <= _REWIRE_MAX and len(add_only) <= _REWIRE_MAX
        out[h.id] = {"removed": rem_only, "added": add_only} if crisp \
            else {"removed": [], "added": []}
    return out


def resolve_alias(used_symbols: set[str], candidate_cores: dict[str, set[str]],
                  file_text: str) -> dict[str, set[str]]:
    """Filesystem-resolver step (the §I 'go look outside the diff' move): map a local
    WRAPPER/ALIAS a hunk uses to the core it wraps. The block renders `NewWebhookButton`
    but the core defines `CreateNewWebhookButton` — a wrapper defined in the unchanged
    part of the file. Reading the file, if a used PascalCase symbol X is DEFINED locally
    and its definition references a candidate core's symbol, X is that core's alias.
    {core_id: {alias_symbols}}. Pure: caller supplies the file text (the resolver
    backend; a VsCodeResolver would answer the same question via go-to-definition)."""
    lines = file_text.splitlines()
    out: dict[str, set[str]] = {}
    for x in used_symbols:
        for i, ln in enumerate(lines):
            if re.search(rf"\b(?:const|let|var|function)\s+{re.escape(x)}\b", ln):
                block = "\n".join(lines[i:i + 8])  # the def + a few lines of body
                for cid, csyms in candidate_cores.items():
                    if any(re.search(rf"\b{re.escape(cs)}\b", block) for cs in csyms):
                        out.setdefault(cid, set()).add(x)
                break
    return out


def _coalesce(lines: list[int], gap: int) -> list[tuple[int, int]]:
    """Merge sorted line numbers into (start, end) ranges, bridging gaps <= `gap`
    (a JSX block names its component only on a few lines but spans the rest)."""
    out: list[tuple[int, int]] = []
    for ln in lines:
        if out and ln - out[-1][1] <= gap:
            out[-1] = (out[-1][0], ln)
        else:
            out.append((ln, ln))
    return out


def segment_link_by_core(link: Hunk, core_defs: dict[str, set[str]],
                         gap: int = 10) -> dict[str, list[tuple[int, int]]]:
    """Locate, WITHIN a big link hunk, the line ranges that reference each core's
    DEFINED symbols → {core_id: [(start,end), ...]} over the hunk's BODY line numbering
    (1-based, the model's gutter). This is the FLOOR for span-level wiring: a big
    multi-core link (one render touching several migrated components) decomposes so
    each region wires the core it actually uses, instead of the whole block landing
    in every seam.

    A core used by its LITERAL name is located precisely. A core reached through an
    ALIAS / local wrapper (the block uses a different name than the core defines —
    `NewWebhookButton` for `CreateNewWebhookButton`, an informal coupling, §4) is NOT
    located here: it is absent from the result and left to the resolver / Pass-C
    hunk-level wiring. Grounding is the floor, not the ceiling."""
    body = link.text.splitlines()[1:]  # drop the @@ header; body is 1-based
    hits: dict[str, list[int]] = {}
    for ln, raw in enumerate(body, 1):
        toks = set(_IDENT.findall(raw))
        for cid, defs in core_defs.items():
            if toks & defs:
                hits.setdefault(cid, []).append(ln)
    return {cid: _coalesce(sorted(set(lns)), gap) for cid, lns in hits.items()}


def candidate_wirings(hunks: list[Hunk]) -> dict[str, list[tuple[str, str]]]:
    """Per hunk, the OTHER hunks it shares a DISTINCTIVE NEW symbol with, plus that
    symbol: {hunk_id: [(other_hunk_id, symbol), ...]}. Symmetric def<->ref grounding
    — h links to other when one DEFINES a new-vocab symbol the other REFERENCES.
    Empty list for a hunk with no grounded sharing (the model wires it, if at all,
    from informal cues). Deterministic and fast (no LLM).

    AMBIENT FILTER (the precision lever): a symbol shared across MANY hunks is
    ambient (a shared util/field used everywhere) — wiring on it produces a hairball
    of 'environment noise wearing a link costume'. We drop symbols whose document
    frequency exceeds a third of the hunks (floor 5): distinctive types like
    `SupabaseBoosterRepository` (few hunks) survive; ubiquitous `member`/`boosters`
    do not. The model still prunes the rest by intent and adds informal edges."""
    dr = {h.id: _defs_refs(h.text) for h in hunks}
    new_vocab: set[str] = set().union(*(d for d, _ in dr.values())) if dr else set()
    # Document frequency over the union of defs+refs (how widely a symbol appears).
    doc_freq: dict[str, int] = {}
    for d, r in dr.values():
        for sym in (d | r) & new_vocab:
            doc_freq[sym] = doc_freq.get(sym, 0) + 1
    ambient_cut = max(5, len(hunks) // 3)
    distinctive = {s for s in new_vocab if doc_freq.get(s, 0) <= ambient_cut}
    out: dict[str, list[tuple[str, str]]] = {h.id: [] for h in hunks}
    ids = [h.id for h in hunks]
    for i, a in enumerate(ids):
        adef, aref = dr[a]
        for b in ids[i + 1:]:
            bdef, bref = dr[b]
            shared = distinctive & ((adef & bref) | (bdef & aref))
            for sym in sorted(shared):
                out[a].append((b, sym))
                out[b].append((a, sym))
    return out
