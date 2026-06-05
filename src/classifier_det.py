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
    A seam IS one core + the hunks wiring it (seam id == core hunk id).
  - CLUSTERING by connected components over the wiring graph (links merge the cores
    they bridge). Intent is a STRUCTURAL label (the core's primary symbol) — product
    intent has no deterministic oracle and is left to the LLM cluster pass.
  - WELL-FORMEDNESS is computed downstream by `renderer._verify_pair`: a malformed
    seam STAYS flagged (honest failure). Layer 2 (residual LLM) is deliberately NOT
    built here — gated on the pre-registered Phase-0 measurement.

`role_confidence` is the heuristic's MARGIN: a decisive call (test, import-only env,
defines-logic core) ~1.0; an ambiguous fallback ~0.5 so it surfaces as "uncertain".
"""
from __future__ import annotations

import sys

from . import ROLES
from .facts import FactsProvider, HunkFacts, RegexFactsProvider
from .lang import _STOP
from .parser import Hunk
from .symbol_edges import candidate_wirings

# A non-referenced hunk needs this many decision lines to read as core on magnitude alone.
_LOGIC_CORE_THRESHOLD = 2

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


def _subject_wiring(work: list[Hunk], facts: dict[str, HunkFacts],
                    cores: set[str]) -> dict[str, list[str]]:
    """Role-grounded wiring: a non-core hunk wires to every core whose DISTINCTIVE
    subject it mentions. {hunk_id: [core_id, ...]}.

    Distinctiveness is computed over the SUBJECT vocabulary across the whole diff: a
    symbol that is the subject of too many hunks is ambient (a shared util/base type)
    and dropped, so we don't wire a hairball. Because we only ever wire to CORES anchored
    on what they are ABOUT, good roles translate directly into good wiring (measured:
    mean wiring F1 0.17 -> 0.63)."""
    subj = {h.id: _subjects(facts[h.id]) for h in work}
    freq: dict[str, int] = {}
    for ss in subj.values():
        for s in ss:
            freq[s] = freq.get(s, 0) + 1
    cut = max(5, len(work) // 3)
    anchors = {cid: {s for s in subj[cid] if freq[s] <= cut} for cid in cores}
    out: dict[str, list[str]] = {}
    for h in work:
        if h.id in cores:
            out[h.id] = []
            continue
        m = _mentions(facts[h.id])
        out[h.id] = sorted(cid for cid in cores if cid != h.id and (anchors[cid] & m))
    return out


def _primary_symbol(f: HunkFacts, h: Hunk, distinctive: set[str]) -> str:
    """A short label for a core's seam / a cluster's intent: prefer a distinctive symbol
    it defines, else any def, else the section header, else the file stem."""
    pref = sorted(f.defines & distinctive) or sorted(f.defines)
    if pref:
        return pref[0]
    if h.section_header:
        parts = h.section_header.split("(")[0].strip().split()
        return parts[-1] if parts else h.section_header
    stem = (h.file_path or "").rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return stem or h.id


# --------------------------------------------------------------------------- union-find
class _DSU:
    def __init__(self, ids: list[str]):
        self.parent = {i: i for i in ids}

    def find(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


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
    """Fill role/group/intent/seam/wires on each hunk in place — deterministically.

    `facts_provider` is the syntax-source strategy (regex by default; swap in the VS Code
    AST or tree-sitter provider with no other change). Drop-in for `classifier.classify`:
    the LLM-only kwargs (model, claude_bin, …) are accepted and ignored. `hunks` should
    already exclude deterministic noise; any hunk already roled "noise" is left untouched.
    """
    work = [h for h in hunks if h.role != "noise"]
    if not work:
        return

    facts = (facts_provider or RegexFactsProvider()).facts(work)
    cand = candidate_wirings(work)

    # Distinctive new vocabulary == the symbols candidate_wirings actually wires on
    # (post ambient-filter): a symbol that appears as a wiring edge is distinctive.
    distinctive: set[str] = {sym for edges in cand.values() for _, sym in edges}

    # Direction of each grounded edge: who DEFINES the symbol vs who only USES it.
    # `referenced` = hunks that define a distinctive symbol another hunk uses (core
    # anchors). `targets[h]` = the definer hunks h depends on (its wiring candidates).
    dr = {h.id: (facts[h.id].defines, facts[h.id].references) for h in work}
    pure_refs = {hid: (refs - defs) for hid, (defs, refs) in dr.items()}
    referenced: set[str] = set()
    targets: dict[str, set[str]] = {h.id: set() for h in work}
    for hid, edges in cand.items():
        hdefs = dr[hid][0]
        for other, sym in edges:
            if sym in hdefs and sym in pure_refs.get(other, ()):  # hid defines, other uses
                referenced.add(hid)
                targets[other].add(hid)

    # --- roles --------------------------------------------------------------
    rationale: dict[str, str] = {}
    for h in work:
        f = facts[h.id]
        if f.is_test:
            h.role, h.role_confidence = "test", _CONF_TEST
            rationale[h.id] = "test — verifies the change (path/framework markers)"
        elif f.is_sql:
            h.role, h.role_confidence = "environment", _CONF_ENV_SQL
            rationale[h.id] = "environment — SQL schema/data migration (trust delegated)"
        elif f.imports_only or f.type_decl_only:
            h.role = "environment"
            h.role_confidence = _CONF_ENV_IMPORT if f.imports_only else _CONF_ENV_DECL
            rationale[h.id] = ("environment — imports wiring the change in" if f.imports_only
                               else "environment — type/declaration only, no logic")
        elif f.implements:
            # adapter implementing an interface — connects a contract to a backend, does
            # not decide. Caught BEFORE the magnitude test so a big repository impl isn't
            # mistaken for core (the private-app-boosters failure mode).
            h.role, h.role_confidence = "link", _CONF_ADAPTER
            rationale[h.id] = "link — adapter implementing an interface (connects, not decides)"
        else:
            defines_ref = h.id in referenced
            logic = f.decisions
            uses = bool(targets[h.id])
            if defines_ref and logic >= 1:
                h.role, h.role_confidence = "core", _CONF_CORE_DEF_LOGIC
                rationale[h.id] = "core — defines logic other hunks depend on"
            elif logic >= _LOGIC_CORE_THRESHOLD:
                h.role, h.role_confidence = "core", _CONF_CORE_LOGIC
                rationale[h.id] = "core — substantial new behavioral logic"
            elif defines_ref:
                # Defines a distinctive symbol others depend on → it is the subject they
                # wire to. We do NOT demote the logic==0 case to environment — a logic-less
                # definition can still be a core (a React component / table that IS the
                # feature). That call is left to Layer 2.
                h.role, h.role_confidence = "core", _CONF_CORE_DEF
                rationale[h.id] = "core — defines a symbol other hunks depend on"
            elif uses:
                h.role, h.role_confidence = "link", _CONF_LINK
                rationale[h.id] = "link — references a core's symbol (wires it in)"
            elif logic >= 1:
                h.role, h.role_confidence = "core", _CONF_FALLBACK
                rationale[h.id] = "core — some new logic, no clear wiring (uncertain)"
            else:
                h.role, h.role_confidence = "environment", _CONF_FALLBACK
                rationale[h.id] = "environment — no logic or wiring detected (uncertain)"

    cores = {h.id for h in work if h.role == "core"}

    # --- wiring (seams) -----------------------------------------------------
    # A seam IS its core hunk (seam id == core hunk id). Non-cores wire to every core
    # whose distinctive SUBJECT they mention; cores anchor and do not wire.
    wires_map = _subject_wiring(work, facts, cores)
    for h in work:
        if h.role == "core":
            h.seam = h.id
            h.seam_label = _primary_symbol(facts[h.id], h, distinctive)
            h.wires = []
        else:
            h.wires = wires_map[h.id]
            h.seam = ""
            h.seam_label = ""
        h.rationale = rationale.get(h.id, "")
        h.spans = []

    # --- clustering (connected components over the wiring graph) -------------
    # Same subject-anchored edges drive grouping: a hunk lives with the core(s) it
    # wires, and a hunk wiring several cores merges their clusters.
    dsu = _DSU([h.id for h in work])
    for h in work:
        for t in wires_map.get(h.id, ()):
            dsu.union(h.id, t)
    # group ids assigned in first-seen order for stability
    root_to_group: dict[str, str] = {}
    members: dict[str, list[Hunk]] = {}
    for h in work:
        r = dsu.find(h.id)
        g = root_to_group.setdefault(r, f"g{len(root_to_group) + 1}")
        h.group = g
        members.setdefault(g, []).append(h)

    # --- intent label per cluster (structural, not product-level) -----------
    for g, hs in members.items():
        cs = [h for h in hs if h.role == "core"]
        rep = max(cs, key=lambda h: facts[h.id].decisions) if cs else hs[0]
        intent = _primary_symbol(facts[rep.id], rep, distinctive) if cs else (
            rep.section_header or (rep.file_path or "").rsplit("/", 1)[-1] or rep.id)
        for h in hs:
            h.intent = intent

    if verbose:
        counts: dict[str, int] = {}
        for h in work:
            counts[h.role] = counts.get(h.role, 0) + 1
        summary = " ".join(f"{r}={counts.get(r, 0)}" for r in ROLES if counts.get(r))
        print(f"[classifier_det] {len(work)} hunks (deterministic, no LLM): {summary}; "
              f"{len(members)} clusters, {len(cores)} seams", file=sys.stderr)
