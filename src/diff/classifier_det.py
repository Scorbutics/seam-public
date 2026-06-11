"""Deterministic-first classifier — the alternative to the LLM-only `classifier`.

This is the Layer-1 SKELETON from the read-time-decomposition brief, built so it
can be A/B-compared against the LLM-only pipeline without replacing it. It fills
the exact same Hunk fields (`role / group / intent / seam / seam_label / wires /
role_confidence`) so the renderer, `--emit-seams`, and the eval harness consume
it unchanged. Select it with `decompose.py --classifier det` (or the harness
`generate --engine det`).

LANGUAGE INDEPENDENCE: this module contains NO regex and NO language knowledge. It
reasons purely over the universal `HunkFacts` IR produced by `facts.extract`
(defines / references / calls / decisions / enclosing / implements / test). Swap the
producer (regex today, tree-sitter / per-language / VS Code AST tomorrow) and this
file is untouched. An unmodelled language yields empty facts → non-votes → graceful
degradation, never confident misclassification.

What it does (deterministic, zero LLM):

  - ROLES from the facts:
      * test         — `is_test`.
      * environment  — imports-only / type-decl-only blocks, or `.sql` migrations.
      * link         — an adapter (`implements`), or a small edit that REFERENCES a
                       core's subject (it wires, it does not decide).
      * core         — DEFINES a distinctive symbol others depend on, OR carries
                       substantial DECISION logic (`decisions`, the change-magnitude
                       proxy for "aboutness", brief §core/env).
  - WIRING: a non-core hunk wires to every core whose DISTINCTIVE subject it mentions
    (a core's subject = its defs + the modified enclosing symbol + its call subjects).
    A seam IS one TECHNICAL INTENT (one or more cores, merged by `merge_seams`) + the hunks
    wiring it; seam id = a representative core's id.
  - CLUSTERING by connected components over the wiring graph (links merge the cores
    they bridge). Intent is a STRUCTURAL label (the core's primary symbol) — product
    intent has no deterministic oracle and is left to the LLM cluster pass.
  - WELL-FORMEDNESS is computed downstream by `seams._verify_pair`: a malformed
    seam STAYS flagged (honest failure). Layer 2 (residual LLM) is deliberately NOT
    built here — gated on the pre-registered Phase-0 measurement.

`role_confidence` is the heuristic's MARGIN: a decisive call (test, import-only env,
defines-logic core) ~1.0; an ambiguous fallback ~0.5 so it surfaces as "uncertain".
"""
from __future__ import annotations

import os
import re
import sys
from collections import Counter
from pathlib import Path

from .. import ROLES
from .facts import FactsProvider, HunkFacts, RegexFactsProvider, leading_ambient_lines, new_side_lines
from ..core.graph_ir import connected_components
from .lang import _added, _defs_refs, _diff_imports, _STOP
from .parser import Hunk, Placement
from .symbol_edges import candidate_wirings, resolve_alias, segment_link_by_core

# A non-referenced hunk needs this many decision lines to read as core on magnitude alone.
_LOGIC_CORE_THRESHOLD = 2

# A symbol IMPORTED from outside the diff (never defined in it) and used in at least this
# many hunks is shared chrome (a UI primitive / hook like Button, Card, useLocale), NOT a
# seam subject — anchoring on it produces a wiring hairball (measured on cal.com: every
# hunk rendering <Button> wired to every core that mentions Button). A LOW-frequency
# external symbol is kept: it can be the very thing a small change wires in (a new Switch).
_AMBIENT_EXTERNAL_MIN = 3

# A non-core hunk wiring to MORE than this many cores is over-wired (the container
# symptom) — only such hunks are reconciled (deterministic tier 2, then the LLM tier).
# Gold hunks never exceed this, so reconciliation can't touch focused changes.
_RECONCILE_GATE = 4

# Confidence == heuristic margin. Decisive calls high; fallbacks low (→ "uncertain").
_CONF_TEST = 1.0
_CONF_ENV_IMPORT = 1.0
_CONF_ENV_DECL = 0.85
_CONF_ENV_SQL = 0.9
_CONF_ADAPTER = 0.8
_CONF_CORE_DEF_LOGIC = 0.9
_CONF_CORE_LOGIC = 0.7
_CONF_CORE_DEF = 0.65
_CONF_LINK = 0.8
_CONF_FALLBACK = 0.5


def _subject_ok(s: str) -> bool:
    """A symbol distinctive enough to be a seam ANCHOR: a multi-part name — camelCase /
    PascalCase (an uppercase anywhere) OR snake_case (an underscore). Admits snake_case
    (`cgss_android_inject_key_down`) — the dominant convention in C/Python/Ruby. This is
    a distinctiveness predicate, not a language fact, so it lives with the classifier."""
    return len(s) >= 3 and s not in _STOP and (any(c.isupper() for c in s) or "_" in s)


def _subjects(f: HunkFacts) -> set[str]:
    """What a hunk is ABOUT — its seam-anchor candidates when it is a core: the symbols
    it defines + the enclosing symbol it modifies + its call subjects. A superset of
    new-vocab defs: wiring must reach cores that MODIFY existing symbols, not only define."""
    return ({s for s in f.defines if _subject_ok(s)}
            | {s for s in f.enclosing if _subject_ok(s)}
            | {s for s in f.calls if _subject_ok(s)})


def _mentions(f: HunkFacts) -> set[str]:
    """Everything a hunk references — used to ask 'does this hunk point at that core's
    subject?'. Broad on purpose; precision comes from the distinctiveness filter on the
    anchor side."""
    return (f.references
            | {s for s in f.calls if _subject_ok(s)}
            | {s for s in f.enclosing if _subject_ok(s)})


def _anchors(work: list[Hunk], facts: dict[str, HunkFacts],
             cores: set[str]) -> dict[str, set[str]]:
    """Per core, the DISTINCTIVE subject symbols a hunk may wire to it by mentioning.

    Distinctiveness is over the SUBJECT vocabulary across the whole diff: a symbol that is
    the subject of too many hunks is ambient (a shared util/base type) and dropped. We also
    drop shared imported CHROME — symbols imported into the diff but defined NOWHERE in it,
    used across many hunks (Button, useLocale): they pass the frequency cut yet aren't what
    any seam is ABOUT (keeps LOW-frequency externals — a feature the change wires in)."""
    subj = {h.id: _subjects(facts[h.id]) for h in work}
    freq: dict[str, int] = {}
    for ss in subj.values():
        for s in ss:
            freq[s] = freq.get(s, 0) + 1
    cut = max(5, len(work) // 3)
    new_vocab: set[str] = set().union(*(facts[h.id].defines for h in work)) if work else set()
    external = set(_diff_imports(work)) - new_vocab
    ambient_external = {s for s in external if freq.get(s, 0) >= _AMBIENT_EXTERNAL_MIN}
    return {cid: {s for s in subj[cid] if freq[s] <= cut and s not in ambient_external}
            for cid in cores}


def _resolved_edges(work: list[Hunk], facts: dict[str, HunkFacts]) -> dict[str, set[str]]:
    """{hid: set(target hunk_id)} — a hunk imports a symbol that RESOLVES (a real import, located
    by the resolver) to a CHANGED FILE in this diff. A genuine cross-file coupling the in-diff
    symbol grounding can't see: the symbol is defined in that file's UNCHANGED body, so it's in no
    hunk's new-vocab and `candidate_wirings` never links them. We wire to the hunk(s) of the target
    file. Purely ADDITIVE — empty unless a ResolvedFactsProvider filled `resolved_refs`, so a
    regex/tree-sitter run is byte-identical to before."""
    by_file: dict[str, list[str]] = {}
    for d in work:
        by_file.setdefault(os.path.normpath(d.file_path), []).append(d.id)
    out: dict[str, set[str]] = {h.id: set() for h in work}
    for h in work:
        for _sym, tgt in facts[h.id].resolved_refs.items():
            for did in by_file.get(os.path.normpath(tgt), ()):
                if did != h.id:
                    out[h.id].add(did)
    return out


def _subject_wiring(work: list[Hunk], facts: dict[str, HunkFacts],
                    cores: set[str]) -> dict[str, list[str]]:
    """Role-grounded wiring: a non-core hunk wires to every core whose DISTINCTIVE subject
    it mentions (measured: mean wiring F1 0.17 -> 0.63). High recall; the reconcile pass
    trims the precision tail on over-wired container hunks."""
    anchors = _anchors(work, facts, cores)
    out: dict[str, list[str]] = {}
    for h in work:
        if h.id in cores:
            out[h.id] = []
            continue
        m = _mentions(facts[h.id])
        out[h.id] = sorted(cid for cid in cores if cid != h.id and (anchors[cid] & m))
    return out


def reconcile_wiring(work: list[Hunk], facts: dict[str, HunkFacts],
                     gate: int = _RECONCILE_GATE) -> list[Hunk]:
    """Deterministic reconcile (tier 2): on an OVER-WIRED hunk (> `gate` cores — the
    container symptom), keep only edges where the hunk mentions a symbol the core actually
    OWNS (in its `defines`), dropping edges that go only through a rendered/shared component.

    Gated to over-wired hunks because the owns-signal is too noisy to prune authoritatively
    in general (measured: ungated it regresses gold; gated to >4 cores it's a free win — gold
    hunks never wire to that many).

    A hunk with NO owned edge is a legitimate HUB (a header/barrel that declares many cores,
    e.g. `FramedView.h` wiring all its impls) — its edges aren't through a shared *rendered*
    component, so we neither prune it NOR escalate it (the LLM mangles such hubs). Only a
    hunk that HAD owned edges but is STILL over-wired after pruning is genuinely ambiguous —
    those, and only those, are returned as the residual for the LLM tier."""
    cores = {h.id for h in work if h.role == "core"}
    anchors = _anchors(work, facts, cores)
    residual: list[Hunk] = []
    for h in work:
        if h.role == "core" or len(h.wires) <= gate:
            continue
        m = _mentions(facts[h.id])
        owned = [c for c in h.wires if (anchors.get(c, set()) & m) & facts[c].defines]
        if not owned:
            continue  # legitimate hub — don't prune, don't escalate
        h.wires = sorted(owned)
        if len(h.wires) > gate:
            residual.append(h)
    return residual


def grounded_prune(wires: set[str], grounded: set[str],
                   gate: int = _RECONCILE_GATE) -> tuple[set[str], set[str]]:
    """Adaptive over-wire reconcile for the HYBRID path (the det path has its own `reconcile_wiring`;
    the hybrid path previously did none → it hairballed). Per node:

      - within `gate` wires → KEEP everything, so the LLM's implicit/border couplings survive
        (those ungrounded-but-real edges are the whole reason to run the LLM);
      - OVER `gate` wires → drop the UNGROUNDED (LLM-only/topical) edges, keeping the grounded ones
        (`grounded` = symbol-floor ∪ det-owned ∪ resolver-confirmed), so a saturated hub collapses
        to what's actually verifiable;
      - over `gate` but NO grounded edge at all → a legitimate barrel/header HUB (or pure topical):
        left intact, never emptied (mirrors `reconcile_wiring`'s hub protection).

    Returns (kept, suggested) where `suggested` = the surviving UNGROUNDED edges — stamp those LLM /
    render faint ("the model thinks these couple — unverified"), so recall stays but honesty does too."""
    kept = set(wires)
    if len(kept) > gate and (kept & grounded):
        kept &= grounded
    return kept, (kept - grounded)


_SECTION_DEF = re.compile(
    r"\b(?:function|class|interface|enum|const|let|var|val|def|fun)\s+([A-Za-z_]\w*)")


def _primary_symbol(f: HunkFacts, h: Hunk, distinctive: set[str]) -> str:
    """A short label for a core's seam / a cluster's intent — the thing it IDENTIFIES as.

    A core that MODIFIES a component should be named after that component (the enclosing
    `@@` definition, e.g. `EventWebhooksTab`), not after a destructured local it happens to
    define (`readOnly`). So: prefer a distinctive define, but if the best define is a
    lowercase local and the section header names a Component/Type, use that instead."""
    m = _SECTION_DEF.search(h.section_header or "")
    enclosing_def = m.group(1) if m else ""
    # File-top hunk (no @@ header): the enclosing component's signature is a CONTEXT line
    # in the body (the hunk edits its body; the regex producer only adds-line defs miss it).
    # Recover it — the first Component/fn-cased name declared in the hunk — so the seam is
    # named after the component, not an added constant. (A tree-sitter producer resolves
    # this enclosing directly; this is the regex path's degraded equivalent.)
    if not enclosing_def:
        enclosing_def = next((n for n in _SECTION_DEF.findall(h.text)
                              if n[:1].isupper() and not n.isupper()), "")
    pref = sorted(f.defines & distinctive) or sorted(f.defines)
    # A SCREAMING_CASE constant (`MAX_BADGES_TWO_ROWS`) is passive config, rarely the
    # seam subject — pick a Component/fn define (`WebhookListItem`) over it when both
    # exist (the file-top case, where there is no enclosing @@ header to fall back to).
    best = (next((s for s in pref if not s.isupper()), pref[0]) if pref else "")
    # The enclosing @@ scope names what the hunk MODIFIES — a strong 'aboutness' signal.
    # Prefer it over the best define when that define is a poor subject: a lowercase
    # local (`readOnly`) OR a SCREAMING_CASE constant (`MAX_BADGES_TWO_ROWS` — passive
    # config, rarely the seam subject), as long as the enclosing names a Component/fn.
    enc_is_component = bool(enclosing_def) and enclosing_def[:1].isupper() and not enclosing_def.isupper()
    if enclosing_def and (not best
                          or (best[:1].islower() and enclosing_def[:1].isupper())
                          or (best.isupper() and enc_is_component)):
        return enclosing_def
    if best:
        return best
    if enclosing_def:
        return enclosing_def
    stem = (h.file_path or "").rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return stem or h.id


# --------------------------------------------------------------------------- passes
# The three passes are independent entry points so a per-pass orchestrator (src/engine)
# can mix deterministic and LLM engines: each reads the accumulated state on the hunks
# (wiring reads roles; clustering reads wiring) regardless of which engine set it.

def _distinctive(work: list[Hunk]) -> set[str]:
    """Symbols the def↔use grounding actually wires on (post ambient-filter) — used to
    prefer a meaningful seam/intent label."""
    return {sym for edges in candidate_wirings(work).values() for _, sym in edges}


def assign_roles(work: list[Hunk], facts: dict[str, HunkFacts]) -> None:
    """ROLES pass: fill role / role_confidence / rationale from the facts IR."""
    cand = candidate_wirings(work)
    dr = {h.id: (facts[h.id].defines, facts[h.id].references) for h in work}
    pure_refs = {hid: (refs - defs) for hid, (defs, refs) in dr.items()}
    # Direction of each grounded edge: who DEFINES vs who only USES. `referenced` = hunks
    # that define a distinctive symbol another uses (core anchors); `targets[h]` = the
    # definer hunks h depends on.
    referenced: set[str] = set()
    targets: dict[str, set[str]] = {h.id: set() for h in work}
    for hid, edges in cand.items():
        hdefs = dr[hid][0]
        for other, sym in edges:
            if sym in hdefs and sym in pure_refs.get(other, ()):
                referenced.add(hid)
                targets[other].add(hid)
    # ADDITIVE codebase-grounded edges: a hunk importing from a CHANGED file (a real resolved
    # import) USES that file's change → it reads as a LINK, recovering wiring the in-diff grounding
    # missed. Conservative: we feed only the importer's `targets` (link recall), NOT `referenced`
    # (we don't force-promote the target to core — its role stays its own facts' call). No-op when
    # no resolved_refs were produced (regex/tree-sitter), so those runs are byte-identical.
    for hid, definers in _resolved_edges(work, facts).items():
        targets[hid] |= definers

    for h in work:
        f = facts[h.id]
        if f.is_test:
            h.role, h.role_confidence = "test", _CONF_TEST
            h.rationale = "test — verifies the change (path/framework markers)"
        elif f.is_sql:
            h.role, h.role_confidence = "environment", _CONF_ENV_SQL
            h.rationale = "environment — SQL schema/data migration (trust delegated)"
        elif f.imports_only or f.type_decl_only:
            h.role = "environment"
            h.role_confidence = _CONF_ENV_IMPORT if f.imports_only else _CONF_ENV_DECL
            h.rationale = ("environment — imports wiring the change in" if f.imports_only
                           else "environment — type/declaration only, no logic")
        elif f.implements:
            # adapter implementing an interface — connects, does not decide. Before the
            # magnitude test so a big repository impl isn't mistaken for core.
            h.role, h.role_confidence = "link", _CONF_ADAPTER
            h.rationale = "link — adapter implementing an interface (connects, not decides)"
        else:
            defines_ref = h.id in referenced
            logic = f.decisions
            uses = bool(targets[h.id])
            if defines_ref and logic >= 1:
                h.role, h.role_confidence = "core", _CONF_CORE_DEF_LOGIC
                h.rationale = "core — defines logic other hunks depend on"
            elif logic >= _LOGIC_CORE_THRESHOLD:
                h.role, h.role_confidence = "core", _CONF_CORE_LOGIC
                h.rationale = "core — substantial new behavioral logic"
            elif defines_ref:
                # Defines a distinctive symbol others depend on → it is the subject. NOT
                # demoted to environment on logic==0 (a logic-less React component/table
                # can still be a core); that call is left to Layer 2.
                h.role, h.role_confidence = "core", _CONF_CORE_DEF
                h.rationale = "core — defines a symbol other hunks depend on"
            elif uses:
                h.role, h.role_confidence = "link", _CONF_LINK
                h.rationale = "link — references a core's symbol (wires it in)"
            elif logic >= 1:
                h.role, h.role_confidence = "core", _CONF_FALLBACK
                h.rationale = "core — some new logic, no clear wiring (uncertain)"
            else:
                h.role, h.role_confidence = "environment", _CONF_FALLBACK
                h.rationale = "environment — no logic or wiring detected (uncertain)"


def assign_wiring(work: list[Hunk], facts: dict[str, HunkFacts]) -> None:
    """WIRING pass (reads roles): a seam IS its core hunk (seam id == core id); non-cores
    wire to every core whose distinctive SUBJECT they mention. Works whatever set roles."""
    distinctive = _distinctive(work)
    cores = {h.id for h in work if h.role == "core"}
    wires_map = _subject_wiring(work, facts, cores)
    res_edges = _resolved_edges(work, facts)              # codebase-grounded edges (additive)
    for h in work:
        if h.role == "core":
            h.seam = h.id
            h.seam_label = _primary_symbol(facts[h.id], h, distinctive)
            h.wires = []
            h.resolved_wires = []
        else:
            # Resolved import to an in-diff core is ground truth — add it even if the in-diff
            # grounding missed it; record the resolved subset so the IR can stamp it RESOLVED_FULL.
            rwires = {c for c in res_edges[h.id] if c in cores and c != h.id}
            h.wires = sorted(set(wires_map[h.id]) | rwires)
            h.resolved_wires = sorted(rwires)
            h.seam = ""
            h.seam_label = ""
        h.suggested_wires = []      # set by the hybrid per-node prune (engine); det wiring grounds all
        h.spans = []


def merge_seams(work: list[Hunk]) -> None:
    """Group cores of the SAME technical intent into ONE seam (a seam = an intent, and may
    hold SEVERAL cores), then re-point non-core wires to the seam. Deterministic floor:
    cores in the same file editing the same enclosing component merge — e.g. three hunks of
    one `WebhookForm` component become one seam instead of three. The renderer already groups
    cores by `seam` id (seams.py); the engine just wasn't producing multi-core seams.
    Richer cross-file intent grouping is the LLM's job (the hybrid path). Idempotent; keeps
    the representative core's existing label (so an LLM-named seam keeps its name)."""
    cores = [h for h in work if h.role == "core"]
    groups: dict[tuple, list[Hunk]] = {}
    for c in cores:
        m = _SECTION_DEF.search(c.section_header or "")
        enc = m.group(1) if m else ""
        gkey = (c.file_path, enc) if enc else (c.file_path, c.id)  # no enclosing → its own seam
        groups.setdefault(gkey, []).append(c)
    remap: dict[str, str] = {}
    for (_file, enc), members in groups.items():
        members.sort(key=lambda c: int(c.id[1:]) if c.id[1:].isdigit() else 0)
        rep = members[0]
        label = rep.seam_label or enc or rep.id
        for c in members:
            c.seam = rep.id
            c.seam_label = label
            c.group = rep.group          # a seam ⊂ one cluster: keep merged cores together
            remap[c.id] = rep.id
    for h in work:
        if h.role != "core" and h.wires:
            h.wires = sorted({remap.get(w, w) for w in h.wires})


def _enclosing(c: Hunk) -> str:
    m = _SECTION_DEF.search(c.section_header or "")
    return m.group(1) if m else ""


def _overlap_subgroups(members: list[Hunk], facts: dict[str, HunkFacts]) -> list[list[str]]:
    """Partition same-component cores by SYMBOL OVERLAP. The component floor assumed 'same enclosing
    component ⇒ one seam', which over-merges a big component whose hunks are genuinely DISTINCT
    sub-intents (cal.com `WebhookForm` = time-unit / payload / content). Instead: two cores merge iff
    their distinctive footprints (`defines ∪ calls`, minus the shared component name) intersect, via
    connected components. Hunks touching the SAME symbols (one change over a few hunks — psdk
    `RootActivity`) merge; disjoint sub-intents stay split. Stable (no LLM), so it doesn't depend on
    label quality. Returns a list of id-groups."""
    def footprint(c: Hunk) -> set[str]:
        f = facts[c.id]
        return {s for s in (f.defines | f.calls) if _subject_ok(s)} - {_enclosing(c)}
    ids = [c.id for c in members]
    foot = {c.id: footprint(c) for c in members}
    parent = {i: i for i in ids}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            if foot[ids[i]] & foot[ids[j]]:
                parent[find(ids[i])] = find(ids[j])
    out: dict[str, list[str]] = {}
    for i in ids:
        out.setdefault(find(i), []).append(i)
    return list(out.values())


def apply_seam_groups(work: list[Hunk], labels: dict[str, str],
                      groups: dict[str, str], use_component_floor: bool = True,
                      facts: dict[str, HunkFacts] | None = None) -> None:
    """Merge cores into technical-intent seams for the hybrid path — the UNION of two signals
    so neither can over- or under-merge alone:
      - deterministic FLOOR: same file + same enclosing component (the LLM tends to under-merge
        — it split one component's hunks into sub-intents on cal.com);
      - LLM grouping: cores the model put under the same `seam` key OR gave the same `label`
        (can merge ACROSS files by intent — e.g. a component + its skeleton — which the floor
        can't). Label is included because the model is more consistent on the label than the
        key (it sometimes gives identical labels under different keys).
    Cores connected by any signal land in one seam; wires re-point to the representative.
    Labels prefer the LLM's (`labels`), else the enclosing component."""
    cores = [h for h in work if h.role == "core"]
    parent = {c.id: c.id for c in cores}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        parent[find(a)] = find(b)

    # floor: same file + enclosing component — but SUB-PARTITIONED by symbol overlap so a big
    # component's genuinely-distinct sub-intents stay split (see `_overlap_subgroups`). With no
    # `facts` it degrades to the legacy 'merge all same-component'. `use_component_floor=False`
    # drops the floor entirely (trust the LLM grouping alone).
    comp_groups: list[list[str]] = []
    if use_component_floor:
        by_comp: dict[tuple, list[Hunk]] = {}
        for c in cores:
            enc = _enclosing(c)
            if enc:
                by_comp.setdefault((c.file_path, enc), []).append(c)
        for members in by_comp.values():
            if facts is None or len(members) <= 1:
                comp_groups.append([c.id for c in members])          # legacy: all same-component
            else:
                comp_groups.extend(_overlap_subgroups(members, facts))  # disjointness-aware
    # LLM: same seam key OR same (normalised) label
    bykey: dict[str, list[str]] = {}
    for c in cores:
        if groups.get(c.id):
            bykey.setdefault("k:" + groups[c.id], []).append(c.id)
        lab = (labels.get(c.id) or "").strip().lower()
        if lab:
            bykey.setdefault("l:" + lab, []).append(c.id)
    for ids in (*comp_groups, *bykey.values()):
        for x in ids[1:]:
            union(ids[0], x)

    remap: dict[str, str] = {}
    seam_members: dict[str, list[Hunk]] = {}
    for c in cores:
        seam_members.setdefault(find(c.id), []).append(c)
    for root, members in seam_members.items():
        members.sort(key=lambda c: int(c.id[1:]) if c.id[1:].isdigit() else 0)
        rep = members[0]
        # When a merge still spans cores the model labeled DIFFERENTLY (a big component whose
        # sub-intents share enough symbols to merge), don't inherit one core's narrow sub-label —
        # it mislabels the whole. Use the enclosing component, which is honest for the set.
        distinct = {(labels.get(c.id) or "").strip().lower()
                    for c in members if (labels.get(c.id) or "").strip()}
        if len(distinct) > 1:
            label = _enclosing(rep) or labels.get(rep.id) or rep.seam_label or rep.id
        else:
            label = labels.get(rep.id) or _enclosing(rep) or rep.seam_label or rep.id
        for c in members:
            c.seam = rep.id
            c.seam_label = label
            c.group = rep.group          # a seam ⊂ one cluster: keep merged cores together
            remap[c.id] = rep.id
    for h in work:
        if h.role != "core" and h.wires:
            h.wires = sorted({remap.get(w, w) for w in h.wires})
            if h.suggested_wires:        # keep the faint/ungrounded subset in the same seam-id space
                h.suggested_wires = sorted({remap.get(w, w) for w in h.suggested_wires})


def merge_clusters_by_intent(work: list[Hunk]) -> None:
    """Collapse clusters that share an IDENTICAL intent label into one. The LLM cluster pass often
    emits several single-hunk clusters with the same label (one 'Update global styles' per CSS
    hunk, one 'Update dependencies' per package.json line) — same product intent should read as ONE
    cluster, not a wall of repeated headings. Keyed on the normalised (case/space-folded) label; the
    first-appearing group id wins, so cluster order is preserved. No-op when labels are all distinct,
    and empty-intent groups are left alone. A post-pass over `group` only — seams/wiring untouched."""
    rep: dict[str, str] = {}            # normalised intent -> representative group id (first seen)
    remap: dict[str, str] = {}
    for h in work:
        g = h.group
        if not g or g in remap:
            continue
        key = (h.intent or "").strip().lower()
        if not key:
            remap[g] = g
            continue
        remap[g] = rep.setdefault(key, g)
    for h in work:
        if h.group:
            h.group = remap.get(h.group, h.group)


def assign_clusters(work: list[Hunk], facts: dict[str, HunkFacts]) -> None:
    """CLUSTERING pass (reads wiring): connected components over the wiring graph; `intent`
    is a STRUCTURAL label (the cluster's core symbol). Product-intent prose is the LLM's
    job — prefer the LLM cluster pass; this is the offline fallback.

    The PARTITION itself is the mode-agnostic Layer-4 op shared with codebase-mode
    (`graph_ir.connected_components`); only the structural `intent` LABELLING below is
    diff-specific and stays here (assignment forks by mode — plan §1.1)."""
    distinctive = _distinctive(work)
    edges = [(h.id, t) for h in work for t in h.wires]   # non-core → its cores; merges shared cores
    groups = connected_components([h.id for h in work], edges)
    members: dict[str, list[Hunk]] = {}
    for h in work:
        h.group = groups[h.id]
        members.setdefault(h.group, []).append(h)
    for g, hs in members.items():
        cs = [h for h in hs if h.role == "core"]
        rep = max(cs, key=lambda h: facts[h.id].decisions) if cs else hs[0]
        intent = _primary_symbol(facts[rep.id], rep, distinctive) if cs else (
            rep.section_header or (rep.file_path or "").rsplit("/", 1)[-1] or rep.id)
        for h in hs:
            h.intent = intent


# --------------------------------------------------------------------------- spans / overlap
def _locate(h: Hunk, targets: dict[str, set[str]], nmap: dict[str, int | None],
            seam_of: dict[str, str]) -> dict[str, tuple[int, int]]:
    """Find, per target core, the NEW-side line range of the region in `h`'s body that
    references that core's symbols → {seam_id: (file_start, file_end)}. The grounding
    floor (segment_link_by_core, body lines) converted to file lines via `nmap`."""
    seg = segment_link_by_core(h, targets)
    spans: dict[str, tuple[int, int]] = {}
    for cid, ranges in seg.items():
        flines = [fl for (s, e) in ranges for ln in range(s, e + 1)
                  if (fl := nmap.get(ln)) is not None]
        if flines:
            spans[seam_of.get(cid, cid)] = (min(flines), max(flines))
    return spans


def assign_spans(work: list[Hunk], repo: str | None = None) -> None:
    """SPANS / OVERLAP pass (reads roles + wiring): fill `h.placements` — the per-seam
    sub-range attachments + the leading-ambient header peel — so the renderer presents the
    overlap without recomputing it. Deterministic, engine-agnostic (works off the diff text
    and the flat roles whatever set them), and ADDITIVE (never touches role/seam/wires).

      - PEEL (Phase 1): a fused core/link that opens with an import/decl header gets an
        `environment` placement (seam="") over that header.
      - CORE→SIBLING (Phase 2, the OVERLAP): a core whose body references OTHER cores'
        DISTINCTIVE symbols is placed as a `link` sub-range into each sibling's seam, while
        it stays whole/core in its own seam — meaning is seam-dependent.
      - LINK SPLIT: a link/env wiring SEVERAL cores splits into the per-core region wiring
        each (only when >= 2 are located); a core reached via an alias/wrapper is resolved
        against the working-tree file when `repo` is given (best-effort).
    """
    core_defs = {h.id: _defs_refs(h.text)[0] for h in work if h.role == "core"}
    seam_of = {h.id: (h.seam or h.id) for h in work if h.role == "core"}
    def_freq = Counter(s for defs in core_defs.values() for s in defs)
    for h in work:
        h.placements = []
        nmap = new_side_lines(h)
        if h.role in ("core", "link"):
            k = leading_ambient_lines(h)
            if k:
                head = [fl for i in range(1, k + 1) if (fl := nmap.get(i)) is not None]
                rest = [fl for i in range(k + 1, len(h.text.splitlines()))
                        if (fl := nmap.get(i)) is not None]
                if head and rest:
                    h.placements.append(Placement(seam="", role="environment",
                                                  start=min(head), end=max(head)))
        if h.role == "core":
            own = h.seam or h.id
            sib = {cid: {s for s in d if def_freq[s] <= 1}
                   for cid, d in core_defs.items()
                   if cid != h.id and seam_of.get(cid) != own}
            sib = {cid: d for cid, d in sib.items() if d}
            spans = _locate(h, sib, nmap, seam_of) if sib else {}
            spans.pop(own, None)
            for seam, (s, e) in spans.items():
                h.placements.append(Placement(seam=seam, role="link", start=s, end=e))
        elif h.role in ("link", "environment"):
            wired = [c for c in h.wires if c in core_defs]
            if len(wired) >= 2:
                cd = {c: set(core_defs[c]) for c in wired}
                seg = segment_link_by_core(h, cd)
                unlocated = [c for c in wired if c not in seg]
                if unlocated and repo:
                    try:
                        ftext = Path(repo, h.file_path).read_text(encoding="utf-8")
                        used = set(re.findall(r"<([A-Z]\w+)", _added(h.text)))
                        aliases = resolve_alias(used, {c: core_defs[c] for c in unlocated}, ftext)
                        if aliases:
                            for c, names in aliases.items():
                                cd[c] |= names
                    except OSError:
                        pass
                spans = _locate(h, cd, nmap, seam_of)
                if len(spans) >= 2:                 # only worth splitting if >= 2 located
                    for seam, (s, e) in spans.items():
                        h.placements.append(Placement(seam=seam, role=h.role, start=s, end=e))


# --------------------------------------------------------------------------- main
def classify(
    hunks: list[Hunk],
    *,
    facts_provider: FactsProvider | None = None,
    model: str | None = None,
    claude_bin: str | None = None,
    context_window: int | None = None,
    role_votes: int | None = None,
    verbose: bool = False,
    debug: bool = False,
    debug_path: str | None = None,
) -> None:
    """Fully deterministic decomposition (roles + wiring + clusters), in place. A drop-in
    for `classifier.classify`; LLM-only kwargs are accepted and ignored. For a hybrid
    (LLM clusters + deterministic roles/wiring) use `src/engine.classify`."""
    work = [h for h in hunks if h.role != "noise"]
    if not work:
        return
    facts = (facts_provider or RegexFactsProvider()).facts(work)
    assign_roles(work, facts)
    assign_wiring(work, facts)
    reconcile_wiring(work, facts)   # deterministic over-wiring cleanup (hubs protected; gold-safe)
    assign_clusters(work, facts)    # cluster on the FULL wiring graph BEFORE merging seams
    merge_seams(work)               # then group same-intent cores into multi-core seams
    assign_spans(work)              # per-seam overlap placements + header peel (presentation IR)
    if verbose:
        counts: dict[str, int] = {}
        for h in work:
            counts[h.role] = counts.get(h.role, 0) + 1
        summary = " ".join(f"{r}={counts.get(r, 0)}" for r in ROLES if counts.get(r))
        n_clusters = len({h.group for h in work if h.group})
        n_cores = sum(1 for h in work if h.role == "core")
        print(f"[classifier_det] {len(work)} hunks (deterministic, no LLM): {summary}; "
              f"{n_clusters} clusters, {n_cores} seams", file=sys.stderr)
