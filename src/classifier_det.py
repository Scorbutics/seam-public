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

import re
import sys

from . import ROLES
from .facts import FactsProvider, HunkFacts, RegexFactsProvider
from .lang import _diff_imports, _STOP
from .parser import Hunk
from .symbol_edges import candidate_wirings

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
    pref = sorted(f.defines & distinctive) or sorted(f.defines)
    best = pref[0] if pref else ""
    if enclosing_def and (not best or (best[:1].islower() and enclosing_def[:1].isupper())):
        return enclosing_def
    if best:
        return best
    if enclosing_def:
        return enclosing_def
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
    for h in work:
        if h.role == "core":
            h.seam = h.id
            h.seam_label = _primary_symbol(facts[h.id], h, distinctive)
            h.wires = []
        else:
            h.wires = wires_map[h.id]
            h.seam = ""
            h.seam_label = ""
        h.spans = []


def assign_clusters(work: list[Hunk], facts: dict[str, HunkFacts]) -> None:
    """CLUSTERING pass (reads wiring): connected components over the wiring graph; `intent`
    is a STRUCTURAL label (the cluster's core symbol). Product-intent prose is the LLM's
    job — prefer the LLM cluster pass; this is the offline fallback."""
    distinctive = _distinctive(work)
    dsu = _DSU([h.id for h in work])
    for h in work:
        for t in h.wires:                       # non-core → its cores; merges shared cores
            if t in dsu.parent:
                dsu.union(h.id, t)
    root_to_group: dict[str, str] = {}
    members: dict[str, list[Hunk]] = {}
    for h in work:
        r = dsu.find(h.id)
        g = root_to_group.setdefault(r, f"g{len(root_to_group) + 1}")
        h.group = g
        members.setdefault(g, []).append(h)
    for g, hs in members.items():
        cs = [h for h in hs if h.role == "core"]
        rep = max(cs, key=lambda h: facts[h.id].decisions) if cs else hs[0]
        intent = _primary_symbol(facts[rep.id], rep, distinctive) if cs else (
            rep.section_header or (rep.file_path or "").rsplit("/", 1)[-1] or rep.id)
        for h in hs:
            h.intent = intent


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
    assign_clusters(work, facts)
    if verbose:
        counts: dict[str, int] = {}
        for h in work:
            counts[h.role] = counts.get(h.role, 0) + 1
        summary = " ".join(f"{r}={counts.get(r, 0)}" for r in ROLES if counts.get(r))
        n_clusters = len({h.group for h in work if h.group})
        n_cores = sum(1 for h in work if h.role == "core")
        print(f"[classifier_det] {len(work)} hunks (deterministic, no LLM): {summary}; "
              f"{n_clusters} clusters, {n_cores} seams", file=sys.stderr)
