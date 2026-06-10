"""Classification service — buckets hunks into roles via the Claude Code CLI.

Uses the local `claude` binary in headless mode (`claude -p ... --output-format
json`), which authenticates through the user's Claude Code subscription. No API
key, no per-token billing.

Design choices that matter (see plan):
  - ONE pass over the WHOLE remaining diff, not per-hunk. The model's value here
    is triangulation (§3): core and link only reveal intent *together*. A hunk
    classified in isolation can't be reliably typed.
  - TWO GRAINS OF INTENT (plan §D). This tool decomposes a diff into INTENT, at
    two tiers: functional CLUSTERS carry the *product* intent ("what are we
    building"); individual SEAMS carry the finer *technical* intent ("introduce
    strategy pattern"). The two passes below own one grain each — keep them
    distinct so the model doesn't collapse product intent into technical intent.
  - LABEL, do not evaluate. The prompt forbids any quality judgement; rationales
    are structuring notes, never verdicts.

Swap this module to a different backend (API SDK, local model) without touching
callers — it only needs to fill `role` and `rationale` on each Hunk.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .. import ROLES
from .parser import Hunk, Span
from ..core.llm import (_dbg, _run_backend, _run_pass, resolve_backend)  # LLM/CLI plumbing now lives in core

_VSCODE_EXT_GLOB = "anthropic.claude-code-*/resources/native-binary/claude"

# --- rough token budgeting (cheap heuristic, no tokenizer dependency) ---
# Code/diffs run denser than prose; ~3.5 chars/token slightly OVER-estimates,
# which is what we want for an early "may not fit" warning.
_CHARS_PER_TOKEN = 3.5
# Nominal context window for the default Haiku tier.
DEFAULT_CONTEXT_WINDOW = 200_000
# The claude CLI injects its own system prompt + tool defs (~16-20K tokens
# observed); reserve headroom so the usable budget reflects reality.
_SYSTEM_OVERHEAD_TOKENS = 25_000
# Rough output size per hunk (the {id, role, rationale} object).
_OUTPUT_TOKENS_PER_HUNK = 60

# Per-pass thinking budgets (passed to the backend; see _run_backend). Clustering
# is reasoning-heavy and needs thinking, but NOT unbounded: uncapped it burned
# ~15-22K thinking tokens. CAPPED at a budget that still holds cluster F1 ~1.0 on
# the harness while cutting output tokens + the latency floor (the cluster pass is
# the wall-clock floor after parallelization). Roling is local — thinking OFF (0),
# more accurate AND faster. Re-measure cluster F1 via eval/harness.py if you change
# CLUSTER_THINKING; raise it if F1 drops.
CLUSTER_THINKING: int | None = 2048
ROLE_THINKING: int | None = 0


ROLE_VOTES = 3


def estimate_tokens(text: str) -> int:
    """Cheap char-based token estimate (no tokenizer). Intentionally high."""
    return int(len(text) / _CHARS_PER_TOKEN) + 1


def fits_context(prompt: str, n_hunks: int, context_window: int = DEFAULT_CONTEXT_WINDOW) -> tuple[bool, int, int]:
    """Return (fits, estimated_input_tokens, usable_budget_tokens)."""
    est_in = estimate_tokens(prompt)
    est_out = n_hunks * _OUTPUT_TOKENS_PER_HUNK
    usable = context_window - _SYSTEM_OVERHEAD_TOKENS
    return (est_in + est_out <= usable, est_in, usable)


_PROMPT_CLUSTER = """\
You are a STRUCTURING tool for code review. You DECOMPOSE a diff. You do NOT
review, judge, score, or comment on quality.

Your ONLY job in this pass: GROUP the hunks into FUNCTIONAL CLUSTERS — each one a
distinct PRODUCT INTENT (the "what are we building" of a coherent sub-change),
using the whole diff as context. A diff often bundles several distinct product
intents; each becomes one cluster. This is the COARSER of two grains of intent:
clusters carry PRODUCT intent here, while the finer TECHNICAL intent of each
individual seam (e.g. "introduce strategy pattern") is named in a separate pass —
do NOT reach for that finer grain here. Grouping is GRAMMAR-driven (what wires to
what), NOT topic similarity: put a link in the SAME cluster as the core it wires
in — the joint and the thing it joins belong together. Give each cluster a stable
id ("g1", "g2", ...) and a short product-intent label (<= 8 words). One product
intent = one cluster, even if it spans several files.

PREFER THE FEWEST CLUSTERS that still separate genuinely independent intents. Be
COARSE, not fine:
- Introducing one new thing and migrating several call-sites to it is ONE intent
  (one core + its links across many files), NOT one cluster per call-site.
- A helper/strategy that exists only to serve a new mechanism belongs in the SAME
  cluster as that mechanism — even if it lives in a different file.
- Split into separate clusters ONLY when two intents could ship in separate PRs
  without depending on each other. If unsure, MERGE.

Return ONLY a JSON array, no prose, no markdown fences. One object per hunk:
[{"id":"h1","group":"g1","intent":"add currency to checkout"},
 {"id":"h2","group":"g1","intent":"add currency to checkout"}]
Every hunk in the same group MUST repeat the same intent string.

=== HUNKS ===
"""

_PROMPT_SEAM_ROLE = """\
You are a STRUCTURING tool for code review. You DECOMPOSE a diff. You do NOT
review, judge, score, or comment on quality.

Using the whole diff as context, SEAM and ROLE each hunk. You do NOT group hunks
into intents — intent CLUSTERS are decided in a separate pass; here you only get
the seams and roles right.

1) SEAM the hunks into core↔link wirings. A seam is ONE core (the new/changed
   thing) together with the link(s) that wire THAT core into the system. Cores are
   ANCHORS; links POINT AT the cores they wire — BY HUNK ID. MANY-TO-MANY:
   - A CORE hunk anchors its own seam. Give it a short `seam_label` (<= 6 words)
     naming it. The core is identified by ITS OWN hunk id — do NOT invent seam ids.
     Put `seam_label` ONLY on cores; a core does not list `wires`.
   - Every LINK (and environment) hunk lists `wires`: the HUNK IDS of the CORE(S)
     it wires (e.g. "wires":["h5","h12"]). List EVERY core it touches — its FULL
     FOOTPRINT: a hunk supporting several cores names ALL of them. A truly dangling
     link has "wires":[]. Reference cores by their GIVEN hunk id; never invent ids,
     and only wire ids that are actually `core` hunks.

   GROUNDING — wiring is TRACING (which symbol defined here is referenced there),
   not guessing. Each hunk may carry a `candidates:` line listing other hunk ids it
   mechanically SHARES A NEW SYMBOL with (one defines it, the other references it),
   e.g. "candidates: h5 (BoosterRepository)". These are HIGH-PRECISION real
   references — use them as your FLOOR: when a link references a CORE's new symbol,
   that candidate IS a wiring (wire it). Two judgements remain YOURS:
   (a) PRUNE ambient candidates — a shared util/import used everywhere is NOT
       intent; that hunk is `environment` and may wire nothing. Keep only
       candidates that carry the change's INTENT.
   (b) ADD informal wirings the scan can't see — couplings by convention, not by a
       shared symbol. Candidates are a FLOOR, never a ceiling.
   Candidates pointing at non-core hunks just tell you those hunks relate; resolve
   the actual `wires` to the CORE(s) in that neighbourhood.

2) ROLE each hunk. `core` is the SCARCE, expensive role — DEFAULT to link or
   environment and promote to core only when the hunk clears the bar below. A
   typical change has only 1–3 cores (the genuinely new logic the change is ABOUT)
   surrounded by MANY links/environment. If you find yourself marking most hunks
   core, you are wrong — re-read.

   - core: contains the new DECISION / ALGORITHM / behavioral logic that IS the
     point of the change. Test: "if this hunk were subtly wrong, would the
     FEATURE itself be wrong (not just disconnected)?" Only then is it core.
     SIZE AND SHAPE DO NOT DECIDE ROLE: a one-line guard, a predicate, or a
     helper-shaped function that encodes a new DECISION — computing WHEN, WHETHER,
     or WHICH something happens (a rule/policy) — is CORE, even if tiny or
     utility-looking. A new rule is core no matter how few lines it takes. A
     constant or config value that DECIDES behavior (a threshold, limit, or policy
     that changes what the code does) is also core, not passive data.
   - link: exists to CONNECT the new thing to existing code — call sites, params
     threaded across layers, signature/interface matches, AND adapter/repository
     implementations that merely fulfill a contract (a DB query or in-memory store
     that backs an interface is a LINK, not core — it APPLIES a rule defined
     elsewhere). An adapter is core ONLY IF its query is the SOLE place a business
     rule lives — the decision of which/when is expressed nowhere else. Registering
     a new object into a parent is a link. A guard that merely ROUTES/DISPATCHES by type to wire a new thing
     in is routing → link; but a guard that DECIDES a behavioral outcome is a
     rule → core. The line is "decides an outcome" (core) vs "connects" (link).
     A guard that ENFORCES A POLICY — excludes, filters, or decides eligibility
     for a behavioral reason ("skip X", "only when Y") — is a rule → CORE, even
     though it is shaped like a guard. Do not let the guard SHAPE pull it to link.
   - test: code that VERIFIES the change (unit/integration tests, assertions,
     fixtures, mocks for tests). A test COVERS the core(s) it exercises — it is
     NOT the change and NOT a link. Put the HUNK ID(s) of the core(s) it covers in
     `wires` (this is COVERAGE, not wiring). A test is `test` regardless of how
     much logic it contains.
   - environment: ambient SUPPORT, not logic — new type/interface/field
     declarations, default-initializing a new field, imports/includes, globals,
     PASSIVE config/data values (inputs CONSUMED by logic defined elsewhere),
     shared utilities. It introduces NO new decision — only scaffolding or ripple.
   - noise: formatting/indentation that slipped through — no logical effect.

   Common mistakes to AVOID (these are NOT core): declaring a type/field/interface
   (environment); importing the new module (environment); implementing a
   repository/adapter that backs a contract (link); threading a parameter or
   editing a call site (link); a constructor initializing a new field
   (environment). Reserve core for the few hunks carrying the actual new logic.

3) SPANS — when ONE hunk genuinely carries MORE THAN ONE role, split it INSIDE
   the hunk instead of forcing a single label. The hunk's BODY lines are
   gutter-numbered (e.g. "  3| +foo"); a span names a CONTIGUOUS line range in
   that numbering. STRONG BIAS: do NOT split. Only emit spans when the roles
   genuinely DIFFER — never to chop one role into pieces. AT MOST ONE `core` span
   per hunk; do not invent extra cores just to split. A hunk that is one role
   end-to-end has NO spans (use the flat role).
   IMPORTANT: do NOT let leading import/include/require lines decide a hunk's
   role. When a hunk starts with imports but then adds new LOGIC, the imports are
   environment and the LOGIC keeps its own role — emit spans (imports = environment,
   the logic = its real role, often core). Never label the whole hunk environment
   or link just because it opens with imports.

Return ONLY a JSON array, no prose, no markdown fences. One object per hunk. Do
NOT emit group/intent — those are derived from your wiring.
A MONO-ROLE hunk: a core names itself (seam_label, no wires); a link/environment
lists the core HUNK IDS it wires:
[{"id":"h1","role":"core","seam_label":"currency gateway","rationale":"<=12 words"},
 {"id":"h2","role":"link","wires":["h1"],"rationale":"<=12 words"}]
A FUSED hunk: omit the top-level role and give `spans` (line ranges over the
gutter numbering); a core span names itself by the hunk's own id:
[{"id":"h3","spans":[
    {"role":"environment","lines":"1-4","rationale":"new imports for gateway"},
    {"role":"core","lines":"5-19","seam_label":"currency gateway","rationale":"new conversion logic"}]}]
Wire links to cores BY HUNK ID (a link wiring the core in h3 lists "wires":["h3"]).
The rationale is a STRUCTURING note, never a quality judgement.

=== HUNKS ===
"""


def _number_body(text: str) -> str:
    """Render a hunk with its BODY lines gutter-numbered (1-based), the @@ header
    left bare. The numbers are the index space a `spans` line-range refers to, so
    the model can name a contiguous sub-region unambiguously (e.g. "3-9")."""
    lines = text.rstrip("\n").splitlines()
    if not lines:
        return ""
    out = [lines[0]]  # the @@ header — not numbered
    for i, ln in enumerate(lines[1:], start=1):
        out.append(f"{i:>4}| {ln}")
    return "\n".join(out)


def _fmt_candidates(cands: list[tuple[str, str]]) -> str:
    """Render a hunk's symbol-grounded candidate wirings as one compact line:
    `candidates: h10 (Platform), h14 (injectLockedActions)`. Groups symbols by the
    other hunk id. Empty -> '' (no grounded sharing; the model wires from cues)."""
    by_other: dict[str, list[str]] = {}
    for other, sym in cands:
        by_other.setdefault(other, [])
        if sym not in by_other[other]:
            by_other[other].append(sym)
    if not by_other:
        return ""
    parts = [f"{o} ({', '.join(syms)})" for o, syms in by_other.items()]
    return "candidates: " + "; ".join(parts)


def _build_prompt(hunks: list[Hunk]) -> str:
    """Pass B (seam+role) prompt — bodies gutter-numbered so spans can cite lines,
    plus a deterministic `candidates:` line per hunk (symbol grounding; see
    symbol_edges.candidate_wirings). Wiring is a grounding task, so we hand pass B
    pre-computed def->use edges to CONFIRM/PRUNE rather than discover from scratch.

    NB: pass B is INDEPENDENT of pass A (roles are accurate without cluster
    context; feeding the intent in was measured to NOT help and to over-correct
    toward under-coring, so it was reverted)."""
    from .symbol_edges import candidate_wirings
    cands = candidate_wirings(hunks)
    parts = [_PROMPT_SEAM_ROLE]
    for h in hunks:
        cand_line = _fmt_candidates(cands.get(h.id, []))
        parts.append(
            f"\n--- HUNK {h.id} | file: {h.file_path} | change: {h.change_type} ---\n"
            f"{_number_body(h.text)}\n"
            + (f"{cand_line}\n" if cand_line else "")
        )
    parts.append("\n=== END HUNKS ===\nReturn the JSON array now.")
    return "".join(parts)


def _build_cluster_prompt(hunks: list[Hunk]) -> str:
    """Pass A (cluster) prompt — no line numbering needed (grouping only)."""
    parts = [_PROMPT_CLUSTER]
    for h in hunks:
        parts.append(
            f"\n--- HUNK {h.id} | file: {h.file_path} | change: {h.change_type} ---\n"
            f"{h.text.rstrip()}\n"
        )
    parts.append("\n=== END HUNKS ===\nReturn the JSON array now.")
    return "".join(parts)


def _parse_spans(item: dict) -> list[Span]:
    """Pull valid `spans` out of a hunk label object (Direction C). Returns the
    list of well-formed spans (role in ROLES); callers decide the threshold for
    treating a hunk as fused. Empty when the hunk has no usable spans."""
    raw = item.get("spans")
    if not isinstance(raw, list):
        return []
    out: list[Span] = []
    for s in raw:
        if not isinstance(s, dict):
            continue
        role = str(s.get("role", "")).strip().lower()
        if role not in ROLES:
            continue
        w = s.get("wires", [])
        wires = [str(x).strip() for x in w if str(x).strip()] if isinstance(w, list) else []
        out.append(Span(
            role=role,
            lines=str(s.get("lines", "")).strip(),
            rationale=str(s.get("rationale", "")).strip(),
            seam=str(s.get("seam", "")).strip(),
            seam_label=str(s.get("seam_label", "")).strip(),
            wires=wires,
        ))
    return out


def _sync_flat_from_spans(h: Hunk, seam_label: dict[str, str]) -> None:
    """Mirror a fused hunk's spans onto the flat role/seam/wires fields so existing
    role-keyed code (renderer, verification) keeps working. The hunk is summarised
    as its core span if it has one (cores drive seams); otherwise its first span.
    A seam IS its core hunk, so a core span's seam id is the PARENT hunk's id.
    `wires` (core hunk ids) and `rationale` are unioned/joined across spans."""
    core = next((s for s in h.spans if s.role == "core"), None)
    primary = core or h.spans[0]
    h.role = primary.role
    h.seam = h.id if core else ""
    h.seam_label = (primary.seam_label or seam_label.get(h.id, "")) if core else ""
    wires: list[str] = []
    for s in h.spans:
        for x in s.wires:
            if x and x not in wires:
                wires.append(x)
    h.wires = wires
    h.rationale = " | ".join(f"{s.role}: {s.rationale}" for s in h.spans if s.rationale)


def _merge_wiring_only_clusters(hunks: list[Hunk]) -> None:
    """Fix a CLUSTERING error the seam-build can't bridge: a cluster with NO core of
    its own, whose links wire core(s) living in exactly ONE other cluster, is a
    mis-grouped piece of THAT cluster's intent — the cluster pass's own rule is
    "a link belongs with the core it wires" (introduce-a-thing + adopt-it = one
    intent). The per-cluster seam-build can't reunite them, so the adopting cluster
    renders as a false 'core-less' (link-only) seam even though the core is right
    there in the diff. Merge it in (reassign its hunks' group) so the seam-build
    puts the links next to their core.

    Discriminator (deterministic, from the link `wires`):
      - links resolve to cores in EXACTLY ONE other cluster -> merge into it;
      - links resolve to NO core anywhere -> a genuine link-only / rewire (wires
        existing codebase code) -> LEAVE (renders as link-only, correctly);
      - links resolve to cores in 2+ clusters -> a real cross-intent bridge ->
        LEAVE (don't guess which to merge into).
    Runs BEFORE _reconcile_wires so the wiring fix then sees the merged groups."""
    seam_group: dict[str, str] = {}          # seam id -> the group its core anchors
    groups_with_core: set[str] = set()
    all_groups: set[str] = set()
    for h in hunks:
        g = h.group or ""
        all_groups.add(g)
        if h.role == "core" and h.seam:
            seam_group[h.seam] = g
            groups_with_core.add(g)
    group_intent = {(h.group or ""): h.intent for h in hunks if h.intent}
    for g in all_groups - groups_with_core:
        members = [h for h in hunks if (h.group or "") == g]
        targets = {tg for h in members if h.role == "link"
                   for w in h.wires if (tg := seam_group.get(w)) and tg != g}
        if len(targets) != 1:
            continue  # genuine link-only (0) or a real multi-intent bridge (2+)
        dest = next(iter(targets))
        if not dest:
            continue
        for h in members:
            h.group = dest
            h.intent = group_intent.get(dest, h.intent)


def _reconcile_wires(hunks: list[Hunk]) -> None:
    """Use the reliable cluster pass to fix noisy link wiring (a 'health' fix, not a
    label fix). Pass B sometimes drifts seam ids WITHIN one response — a link emits
    `wires:["s1"]` while the cores in the same run are labelled s2/s3 — so the link
    resolves to no core and renders as a spurious 'dangling link' that makes the
    report look wrong. Since pass A reliably placed the link in a cluster, we let
    that grouping correct the wiring:
      - drop wire ids that anchor NO core anywhere (hallucinated);
      - if the link sits in a cluster WITH cores but none of its wires resolve
        there, re-point it to that cluster's primary seam (it belongs to the
        intent, just mislabelled);
      - a cluster with no core is genuinely ambient — leave it.
    Cores/seams/clusters are untouched; only link/environment `wires` change.

    NB: the `present[0]` fallback is crude — in a multi-core cluster it snaps every
    unresolved hunk onto the FIRST core, manufacturing a 'junk-drawer' seam (one
    core hoards the cluster while siblings render isolated; see cal.com). But
    REMOVING it is worse: the model's raw per-link wiring is too sparse, so honest
    unwiring disconnects ~everything (measured: cal.com 35/39 unwired, wiring_f1
    0.58->0.43). A deterministic post-process can only trade junk-drawer for barren
    — the fix has to improve the WIRING SIGNAL (model wiring to the right core
    hunk-ids), not this fallback. Kept crude-but-connective until that lands."""
    cluster_seams: dict[str, list[str]] = {}
    all_seams: set[str] = set()
    for h in hunks:
        if h.role == "core" and h.seam:
            all_seams.add(h.seam)
            lst = cluster_seams.setdefault(h.group, [])
            if h.seam not in lst:
                lst.append(h.seam)
    for h in hunks:
        if h.role not in ("link", "environment"):
            continue
        resolved = [w for w in h.wires if w in all_seams]
        present = cluster_seams.get(h.group, [])
        if present:
            in_cluster = [w for w in resolved if w in present]
            h.wires = in_cluster if in_cluster else [present[0]]
        else:
            h.wires = resolved


# --- PASS C: dedicated, core-first wiring (gated by WIRE_PASS env) -------------
# Wiring is a GROUNDING task (tracing which symbol defined here is referenced
# there), not a reasoning one. So instead of asking the role pass to also discover
# edges (which tangles roles with wiring and pulls links toward non-core symbol
# neighbours), we run a SEPARATE pass AFTER roles are known. It is fed the
# SUMMARISED role output (cores with labels, non-cores with rationales) — NOT the
# full diff — plus the deterministic core-anchored symbol candidates as a FLOOR.
# Thinking OFF: the hard tracing is already done; the model only confirms/prunes
# and adds informal edges. Cheap input -> latency-positive.
_PROMPT_WIRE = """\
You are WIRING a decomposed change. The roles are ALREADY decided — do NOT change
them. Your ONLY job: for each NON-CORE hunk, list the CORE hunk id(s) it wires —
its FULL FOOTPRINT (every core it connects to, supports, or tests).

Wiring is TRACING, not guessing. Each non-core hunk lists symbol-grounded CANDIDATE
cores (high precision: it shares a NEW symbol with that core). Use them as your
FLOOR:
  - CONFIRM candidates that carry the change's intent (wire them).
  - PRUNE ambient candidates (a shared util used everywhere is NOT a wiring) — that
    hunk may wire NOTHING.
  - ADD core wirings you infer from the rationales (informal couplings the symbol
    scan can't see).
A hunk wires within its OWN cluster unless it genuinely bridges intents. A purely
ambient hunk (supports the whole change, not any one core) has "wires":[].

The CORES and rationales below are a COMPLETE summary of an already-finished role
pass — you do NOT need the source diff, and you must NOT ask for it. Always return
the JSON array, even if a hunk's footprint is uncertain (use [] when unsure).

Return ONLY a JSON array, no prose, one object per NON-CORE hunk, wiring by CORE
hunk id only:
[{"id":"h1","wires":["h10","h14"]},{"id":"h8","wires":["h7"]},{"id":"h2","wires":[]}]

"""


def _build_wire_prompt(hunks: list[Hunk]) -> str:
    """Pass C prompt — SUMMARISED role output (no diff bodies) + core-anchored
    symbol candidates. Cheap input by design."""
    from .symbol_edges import candidate_wirings
    cands = candidate_wirings(hunks)
    core_ids = {h.id for h in hunks if h.role == "core"}
    parts = [_PROMPT_WIRE, "=== CORES (each anchors a seam) ===\n"]
    for h in hunks:
        if h.role == "core":
            parts.append(f"  {h.id} [{h.seam_label or '—'}] (cluster {h.group or '?'}): "
                         f"{h.rationale or ''}\n")
    parts.append("\n=== NON-CORE hunks to wire ===\n")
    for h in hunks:
        if h.role == "core":
            continue
        cc = list(dict.fromkeys(o for o, _ in cands.get(h.id, []) if o in core_ids))
        cand = ", ".join(cc) if cc else "(none — infer from rationale)"
        parts.append(f"  {h.id} {h.role} (cluster {h.group or '?'}): {h.rationale or ''}\n"
                     f"    candidate cores: {cand}\n")
    parts.append("\nReturn the JSON array now (one object per NON-CORE hunk).")
    return "".join(parts)


def _run_wire_pass(hunks: list[Hunk], kind: str, binary: str, model: str, *,
                   verbose: bool, debug: bool, debug_path: str | None) -> None:
    """Run Pass C and OVERWRITE each non-core hunk's `wires` (filtered to real core
    ids). Cores keep wires=[]. Authoritative — supersedes pass B's wiring."""
    prompt = _build_wire_prompt(hunks)
    labels = _run_pass(kind, binary, prompt, model, thinking=0, tag="wire",
                       verbose=verbose, debug=debug, debug_path=debug_path)
    core_ids = {h.id for h in hunks if h.role == "core"}
    for h in hunks:
        if h.role == "core":
            h.wires = []
            continue
        item = labels.get(h.id) or {}
        raw = item.get("wires", [])
        w = [str(x).strip() for x in raw if str(x).strip()] if isinstance(raw, list) else []
        h.wires = [x for x in w if x in core_ids]


def _eff_role_from_item(item: dict) -> str:
    """Effective role of a label object (handling spans), matching the assignment
    logic — used to compare votes. Unclassified → core (the safe default)."""
    spans = _parse_spans(item)
    if len(spans) >= 2:
        core = next((s for s in spans if s.role == "core"), None)
        return (core or spans[0]).role
    role = str(item.get("role", "")).strip().lower()
    return role if role in ROLES else "core"


def _aggregate_role_votes(runs: list[dict[str, dict]], hunk_ids: list[str], *,
                          verbose: bool = False, debug: bool = False
                          ) -> tuple[dict[str, dict], dict[str, float]]:
    """Self-consistency aggregation of N already-run role passes → (MEDOID run,
    per-hunk confidence). The medoid is the single coherent run whose per-hunk roles
    best match the per-hunk modal. Confidence = share of votes that agreed on the
    modal role (1.0 = unanimous; ~0.4 = a real tie → "uncertain"). Collapses flips
    on dominant-role hunks; only truly split hunks stay low-conf.

    (Per-hunk MODAL aggregation was tried 2026-06 to cut scale instability — it
    barely moved the 66-hunk swing 8→7, cost accuracy on coin-flip hunks, and added
    borrowed-label incoherence. Reverted; the medoid's seam coherence wins.)"""
    if not runs:
        return {}, {hid: 1.0 for hid in hunk_ids}
    if len(runs) == 1:
        return runs[0], {hid: 1.0 for hid in hunk_ids}
    modal: dict[str, str] = {}
    for hid in hunk_ids:
        roles = [_eff_role_from_item(r.get(hid, {})) for r in runs]
        modal[hid] = Counter(roles).most_common(1)[0][0]

    def agreement(r: dict[str, dict]) -> int:
        return sum(_eff_role_from_item(r.get(hid, {})) == modal[hid] for hid in hunk_ids)

    medoid = max(runs, key=agreement)
    # Confidence = share of votes agreeing with the role we ACTUALLY show (the
    # medoid's), not the global modal — so the number reflects the displayed label.
    confidence: dict[str, float] = {}
    for hid in hunk_ids:
        shown = _eff_role_from_item(medoid.get(hid, {}))
        roles = [_eff_role_from_item(r.get(hid, {})) for r in runs]
        confidence[hid] = roles.count(shown) / len(runs)
    if verbose or debug:
        spread = [(hid, dict(Counter(_eff_role_from_item(r.get(hid, {})) for r in runs)))
                  for hid in hunk_ids
                  if len({_eff_role_from_item(r.get(hid, {})) for r in runs}) > 1]
        print(f"[classifier] role voting: {len(runs)} passes, medoid agreement "
              f"{agreement(medoid)}/{len(hunk_ids)}; still-split hunks: {spread or 'none'}")
    return medoid, confidence


# --------------------------------------------------------------------------- standalone passes
# Each LLM pass as an independent entry point so the per-pass orchestrator (src/engine) can
# mix LLM and deterministic engines. `classify` below keeps the optimized concurrent
# all-LLM path; these reuse the same helpers and write the same Hunk fields.

def assign_clusters(hunks: list[Hunk], *, model: str = "claude-haiku-4-5",
                    claude_bin: str | None = None, verbose: bool = False,
                    debug: bool = False, debug_path: str | None = None, **_ignore) -> None:
    """LLM Pass A (cluster) only: fill group/intent (product intent — the LLM's strength)."""
    if not hunks:
        return
    kind, binary = resolve_backend(claude_bin)
    labels = _run_pass(kind, binary, _build_cluster_prompt(hunks), model,
                       thinking=CLUSTER_THINKING, tag="cluster",
                       verbose=verbose, debug=debug, debug_path=debug_path)
    group_intent: dict[str, str] = {}
    groups: dict[str, tuple[str, str]] = {}
    for hid, item in labels.items():
        g = str(item.get("group", "")).strip()
        it = str(item.get("intent", "")).strip()
        groups[hid] = (g, it)
        if g and it and g not in group_intent:
            group_intent[g] = it
    for h in hunks:
        g, it = groups.get(h.id, ("", ""))
        h.group = g
        h.intent = it or group_intent.get(g, "")


def assign_roles(hunks: list[Hunk], *, model: str = "claude-haiku-4-5",
                 claude_bin: str | None = None, role_votes: int = ROLE_VOTES,
                 verbose: bool = False, debug: bool = False, debug_path: str | None = None,
                 **_ignore) -> None:
    """LLM Pass B (role + span) only: fill role / seam / seam_label / wires / spans /
    role_confidence via self-consistency voting (same logic as `classify`)."""
    if not hunks:
        return
    kind, binary = resolve_backend(claude_bin)
    role_prompt = _build_prompt(hunks)
    n_votes = max(1, role_votes)
    hunk_ids = [h.id for h in hunks]
    with ThreadPoolExecutor(max_workers=n_votes) as ex:
        futs = [ex.submit(_run_pass, kind, binary, role_prompt, model, thinking=ROLE_THINKING,
                          tag=("role" if n_votes <= 1 else f"role.v{i + 1}"),
                          verbose=verbose, debug=debug, debug_path=debug_path)
                for i in range(n_votes)]
        role_runs = [f.result() for f in futs]
    labels, role_conf = _aggregate_role_votes(role_runs, hunk_ids, verbose=verbose, debug=debug)
    seam_label: dict[str, str] = {}
    for hid, item in labels.items():
        objs = item.get("spans") if isinstance(item.get("spans"), list) else None
        for src in (objs or [item]):
            if not isinstance(src, dict):
                continue
            if str(src.get("role", "")).strip().lower() != "core":
                continue
            sl = str(src.get("seam_label", "")).strip()
            if sl and hid not in seam_label:
                seam_label[hid] = sl
    for h in hunks:
        h.role_confidence = role_conf.get(h.id, 1.0)
        item = labels.get(h.id) or {}
        spans = _parse_spans(item)
        if len(spans) >= 2:
            h.spans = spans
            _sync_flat_from_spans(h, seam_label)
            continue
        if len(spans) == 1 and str(item.get("role", "")).strip().lower() not in ROLES:
            s = spans[0]
            item = {**item, "role": s.role, "seam": s.seam, "seam_label": s.seam_label,
                    "wires": s.wires, "rationale": s.rationale}
        role = str(item.get("role", "")).strip().lower()
        if role in ROLES:
            h.role = role
            h.rationale = str(item.get("rationale", "")).strip()
            if role == "core":
                h.seam = h.id
                h.seam_label = (str(item.get("seam_label", "")).strip()
                                or seam_label.get(h.id, ""))
                h.wires = []
            else:
                raw = item.get("wires", [])
                h.wires = [str(x).strip() for x in raw if str(x).strip()] if isinstance(raw, list) else []
                h.seam = ""
                h.seam_label = ""
        else:
            h.role = "core"
            h.seam = h.id
            h.rationale = "unclassified — defaulted to core for review"


def assign_wiring(hunks: list[Hunk], *, model: str = "claude-haiku-4-5",
                  claude_bin: str | None = None, verbose: bool = False,
                  debug: bool = False, debug_path: str | None = None, **_ignore) -> None:
    """LLM Pass C (wiring) only — needs roles already set; overwrites non-core wires."""
    if not hunks:
        return
    kind, binary = resolve_backend(claude_bin)
    _run_wire_pass(hunks, kind, binary, model, verbose=verbose, debug=debug, debug_path=debug_path)


_RECONCILE_SNIPPET_LINES = 24


def _reconcile_snippet(h: Hunk) -> str:
    body = [ln for ln in h.text.splitlines()[1:]][:_RECONCILE_SNIPPET_LINES]
    return "\n".join(body)


_CORE_SNIPPET_LINES = 14


def _core_snippet(h: Hunk) -> str:
    return "\n".join(h.text.splitlines()[1:][:_CORE_SNIPPET_LINES])


def _build_reconcile_prompt(cores: dict[str, Hunk], targets: list[Hunk],
                            hints: dict[str, list[str]]) -> str:
    core_blocks = "\n---\n".join(
        f"CORE {cid}  [{h.file_path.rsplit('/', 1)[-1]}]\n{_core_snippet(h)}"
        for cid, h in cores.items())

    def _edit_block(h: Hunk) -> str:
        hint = ", ".join(f'{c}="{cores[c].seam_label or c}"'
                         for c in hints.get(h.id, []) if c in cores) or "(none found)"
        return (f"EDIT {h.id}  [{h.file_path.rsplit('/', 1)[-1]}]  role={h.role}\n"
                f"{_reconcile_snippet(h)}\n  symbols suggest: {hint}")

    edit_blocks = "\n---\n".join(_edit_block(h) for h in targets)
    task2 = (
        "TASK 2 — for each EDIT, draw its true dependency line: which CORES does it ACTUALLY "
        "depend on — calls, modifies, is configured/typed by, or routes to — BY MEANING? The "
        "'symbols suggest' line is a HINT from a crude symbol scan, NOT the answer: confirm the "
        "ones that are real couplings, DROP any it merely co-renders/co-imports a shared "
        "component with, and ADD any real coupling the scan missed. One, several, or NONE; "
        "choose only from the CORE ids.\n\n"
        if targets else "")
    return (
        "A diff is decomposed into CORES (units of new logic) and EDITS that wire into them.\n\n"
        "TASK 1 — group the CORES into SEAMS by TECHNICAL INTENT. A seam is ONE technical "
        "intent and may hold SEVERAL cores: cores that are the same logical change/feature "
        "(several hunks of one component, or a component + its skeleton/header) share one "
        '`seam` key. Give each core that seam key plus a short seam `label` (3-6 words: what '
        'the seam DOES, e.g. "webhook form", "loading skeletons") — NOT a symbol name. Distinct '
        "intents get distinct seam keys; don't over-merge unrelated cores.\n\n"
        f"{task2}"
        f"CORES:\n{core_blocks}\n\n"
        + (f"EDITS:\n{edit_blocks}\n\n" if targets else "")
        + 'Output ONLY a JSON array. Per CORE: {"id":"h8","seam":"S1","label":"…"}.'
        + (' Per EDIT: {"id":"h6","wires":["h8", …]}.' if targets else "")
    )


def reconcile_llm(cores: dict[str, Hunk], targets: list[Hunk], *,
                  hints: dict[str, list[str]] | None = None,
                  model: str = "claude-haiku-4-5", claude_bin: str | None = None,
                  verbose: bool = False, debug: bool = False,
                  debug_path: str | None = None, **_ignore):
    """The hybrid wiring, LLM-FIRST (the inverted design): in ONE call the LLM (1) GROUPS cores
    into technical-intent SEAMS (≥1 core each) and labels them, and (2) DRAWS each EDIT's true
    dependency line BY MEANING, with the deterministic symbol candidates given as a HINT (not the
    authority). Returns (labels, groups, drawn): {core_id: label}, {core_id: seam_key}, {edit_id:
    [core_id, ...]}. Pure — the engine applies the grouping/labels and GROUNDS the draw against
    the deterministic (symbol) wiring (re-adds owned-symbol edges the LLM missed). `drawn` omits a
    hunk only when the LLM gave no list (→ keep det wires); an explicit empty list = 'depends on
    none'."""
    if not cores:
        return {}, {}, {}
    kind, binary = resolve_backend(claude_bin)
    prompt = _build_reconcile_prompt(cores, targets, hints or {})
    out = _run_pass(kind, binary, prompt, model, thinking=0, tag="reconcile",
                    verbose=verbose, debug=debug, debug_path=debug_path)
    labels = {cid: str(o.get("label", "")).strip()
              for cid, o in out.items() if cid in cores and str(o.get("label", "")).strip()}
    # seam grouping: cores sharing a `seam` key are one technical-intent seam (≥1 core)
    groups = {cid: str(o.get("seam", "")).strip()
              for cid, o in out.items() if cid in cores and str(o.get("seam", "")).strip()}
    drawn = {h.id: [c for c in (out.get(h.id) or {}).get("wires", []) if c in cores]
             for h in targets if isinstance((out.get(h.id) or {}).get("wires"), list)}
    if verbose:
        n_seams = len(set(groups.values())) if groups else len(labels)
        print(f"[reconcile] LLM → {n_seams} seams over {len(cores)} cores, "
              f"drew {len(drawn)}/{len(targets)} edits", file=sys.stderr)
    return labels, groups, drawn


def reconcile_roles_llm(work: list[Hunk], *, conf_threshold: float = 0.6,
                        model: str = "claude-haiku-4-5", claude_bin: str | None = None,
                        verbose: bool = False, debug: bool = False,
                        debug_path: str | None = None, **_ignore) -> None:
    """LLM reconcile for ROLES (the hybrid residual): re-judge only the hunks the
    deterministic pass was UNCERTAIN about (low role_confidence). Bounded to the genuinely
    ambiguous core/link/environment calls — the brief's core-vs-environment escalation."""
    targets = [h for h in work if (h.role_confidence or 1.0) < conf_threshold]
    if not targets:
        return
    kind, binary = resolve_backend(claude_bin)
    blocks = "\n---\n".join(f"EDIT {h.id} [{h.file_path}] deterministic_guess={h.role}\n"
                            f"{_reconcile_snippet(h)}" for h in targets)
    prompt = (
        "These diff hunks were role-classified with LOW confidence. For each, pick the one "
        "best role:\n"
        "  core = the new decision/logic/rule the change is ABOUT (verify by reading it);\n"
        "  link = wires/connects the new thing in (call sites, params, adapters) — routes, "
        "doesn't decide;\n"
        "  environment = ambient support touched in passing (types, imports, config, data);\n"
        "  test = verifies the change;  noise = formatting/rename, no logical effect.\n\n"
        f"{blocks}\n\n"
        'Output ONLY a JSON array: [{"id":"h12","role":"link"}, ...]'
    )
    labels = _run_pass(kind, binary, prompt, model, thinking=0, tag="reconcile-roles",
                       verbose=verbose, debug=debug, debug_path=debug_path)
    changed = 0
    for h in targets:
        r = str((labels.get(h.id) or {}).get("role", "")).strip().lower()
        if r in ROLES and r != h.role:
            h.role = r
            changed += 1
    if verbose:
        print(f"[reconcile] LLM re-judged {changed}/{len(targets)} uncertain roles", file=sys.stderr)


def label_clusters_llm(work: list[Hunk], *, model: str = "claude-haiku-4-5",
                       claude_bin: str | None = None, verbose: bool = False,
                       debug: bool = False, debug_path: str | None = None, **_ignore) -> None:
    """LLM reconcile for CLUSTERS (the hybrid): keep the deterministic GROUPING (stable,
    free) but replace its structural labels with product-intent PROSE — the LLM's strength,
    applied to groups it doesn't have to discover. Cheaper than full LLM clustering."""
    groups: dict[str, list[Hunk]] = {}
    for h in work:
        if h.group:
            groups.setdefault(h.group, []).append(h)
    if not groups:
        return
    kind, binary = resolve_backend(claude_bin)
    blocks = []
    for g, hs in groups.items():
        sig = ", ".join(sorted({(h.seam_label or h.file_path.rsplit("/", 1)[-1]) for h in hs}))[:300]
        blocks.append(f"GROUP {g}: {sig}")
    prompt = (
        "Each GROUP is a set of related diff hunks (shown by their key symbols/files). Give "
        "each a SHORT product-intent label — what the user-facing change is, e.g. "
        '"add currency to checkout", "migrate webhooks to v2". Keep it under ~6 words.\n\n'
        + "\n".join(blocks) +
        '\n\nOutput ONLY a JSON array: [{"id":"g1","intent":"…"}, ...]'
    )
    labels = _run_pass(kind, binary, prompt, model, thinking=CLUSTER_THINKING, tag="label-clusters",
                       verbose=verbose, debug=debug, debug_path=debug_path)
    for h in work:
        it = str((labels.get(h.group) or {}).get("intent", "")).strip()
        if it:
            h.intent = it


def classify(
    hunks: list[Hunk],
    *,
    model: str = "claude-haiku-4-5",
    claude_bin: str | None = None,
    context_window: int = DEFAULT_CONTEXT_WINDOW,
    role_votes: int = ROLE_VOTES,
    verbose: bool = False,
    debug: bool = False,
    debug_path: str | None = None,
) -> None:
    """Fill role/rationale on each hunk in `hunks` (mutates in place).

    `hunks` should already exclude deterministic noise. No-op on empty input.
    When `debug`, prints the model's raw reply (and backend diagnostics) to stderr
    and, if `debug_path` is given, writes `<debug_path>.prompt.txt` /
    `<debug_path>.reply.txt` for inspection.
    """
    if not hunks:
        return

    kind, binary = resolve_backend(claude_bin)
    cluster_prompt = _build_cluster_prompt(hunks)

    fits, est_in, usable = fits_context(cluster_prompt, len(hunks), context_window)
    if verbose:
        shown_model = model if kind == "claude" else (os.environ.get("COPILOT_MODEL") or "copilot default")
        print(f"[classifier] {len(hunks)} hunks -> {kind}: {binary} (model={shown_model}); "
              f"2 passes: cluster(think) + seam/role(no-think)")
        print(f"[classifier] ~{est_in:,} input tokens/pass; ~{usable:,} usable")
    if not fits:
        print(
            f"warning: diff is ~{est_in:,} tokens, near/over the ~{usable:,}-token "
            f"usable budget. The classify pass may truncate or fail. "
            f"Try a narrower --git range, or split the diff (chunking is on the roadmap).",
            file=sys.stderr,
        )

    # PASS A (CLUSTER, thinking ON) and PASS B (SEAM+ROLE, thinking OFF) are
    # INDEPENDENT — role accuracy doesn't use cluster context (see _build_prompt),
    # and the role pass is sampled N times for self-consistency. Run the cluster
    # pass and all N role votes CONCURRENTLY: the cheap thinking-off votes then hide
    # under the slow thinking cluster pass instead of adding to it, so wall-clock ≈
    # the cluster pass alone rather than cluster + sum(votes). Each _run_pass is an
    # independent subprocess with its own env, so this is thread-safe.
    role_prompt = _build_prompt(hunks)
    n_votes = max(1, role_votes)
    hunk_ids = [h.id for h in hunks]
    with ThreadPoolExecutor(max_workers=1 + n_votes) as ex:
        cluster_future = ex.submit(_run_pass, kind, binary, cluster_prompt, model,
                                   thinking=CLUSTER_THINKING, tag="cluster",
                                   verbose=verbose, debug=debug, debug_path=debug_path)
        role_futures = [
            ex.submit(_run_pass, kind, binary, role_prompt, model, thinking=ROLE_THINKING,
                      tag=("role" if n_votes <= 1 else f"role.v{i + 1}"),
                      verbose=verbose, debug=debug, debug_path=debug_path)
            for i in range(n_votes)
        ]
        cluster_labels = cluster_future.result()
        role_runs = [f.result() for f in role_futures]

    group_intent: dict[str, str] = {}
    groups: dict[str, tuple[str, str]] = {}
    for hid, item in cluster_labels.items():
        g = str(item.get("group", "")).strip()
        it = str(item.get("intent", "")).strip()
        groups[hid] = (g, it)
        if g and it and g not in group_intent:
            group_intent[g] = it

    labels, role_conf = _aggregate_role_votes(role_runs, hunk_ids,
                                              verbose=verbose, debug=debug)
    if debug:
        _dbg(f"cluster pass: {len({g for g, _ in groups.values() if g})} groups; "
             f"role pass: {len(labels)} labelled hunks")

    # Seam labels — a seam IS its core hunk (seam id = core hunk id), so key the
    # label by the CORE'S hunk id. Scan flat objects and span objects; only cores
    # carry a seam_label. A core missing its label just renders unlabeled.
    seam_label: dict[str, str] = {}
    for hid, item in labels.items():
        objs = item.get("spans") if isinstance(item.get("spans"), list) else None
        for src in (objs or [item]):
            if not isinstance(src, dict):
                continue
            if str(src.get("role", "")).strip().lower() != "core":
                continue
            sl = str(src.get("seam_label", "")).strip()
            if sl and hid not in seam_label:
                seam_label[hid] = sl

    for h in hunks:
        # group/intent from PASS A
        g, it = groups.get(h.id, ("", ""))
        h.group = g
        h.intent = it or group_intent.get(g, "")
        # self-consistency confidence (share of votes agreeing on the role)
        h.role_confidence = role_conf.get(h.id, 1.0)
        # role/seam/wires/spans from PASS B
        item = labels.get(h.id) or {}
        spans = _parse_spans(item)
        if len(spans) >= 2:  # genuinely fused — keep the per-span roles
            h.spans = spans
            _sync_flat_from_spans(h, seam_label)
            continue
        if len(spans) == 1 and str(item.get("role", "")).strip().lower() not in ROLES:
            # A lone span is just a mono-role hunk expressed verbosely — fold it in.
            s = spans[0]
            item = {**item, "role": s.role, "seam": s.seam,
                    "seam_label": s.seam_label, "wires": s.wires, "rationale": s.rationale}
        role = str(item.get("role", "")).strip().lower()
        if role in ROLES:
            h.role = role
            h.rationale = str(item.get("rationale", "")).strip()
            if role == "core":
                # A seam IS its core hunk: the core's own id is its seam id.
                h.seam = h.id
                h.seam_label = (str(item.get("seam_label", "")).strip()
                                or seam_label.get(h.id, ""))
                h.wires = []  # cores anchor; they do not wire
            else:
                # link / environment / test / noise: wires reference core HUNK IDS
                # (full footprint). Resolution to real cores happens in _reconcile.
                raw = item.get("wires", [])
                h.wires = [str(x).strip() for x in raw if str(x).strip()] if isinstance(raw, list) else []
                h.seam = ""
                h.seam_label = ""
        else:
            # Unclassified → default to core (heaviest verification = safe direction).
            h.role = "core"
            h.seam = h.id  # a seam IS its core hunk
            h.rationale = "unclassified — defaulted to core for review"

    # PASS C — dedicated core-first wiring, the DEFAULT wiring authority. Validated
    # best on gold roles (wiring_f1 0.63 vs 0.47 for the present[0] junk-drawer,
    # high precision). It overwrites non-core wires from the summarised role output +
    # symbol floor, so we skip the present[0] reconciliation (which only ever faked
    # footprint density). We still merge core-less clusters off the new wires. Set
    # WIRE_PASS=0 to fall back to pass-B wires + present[0] reconciliation.
    if os.environ.get("WIRE_PASS", "1") != "0":
        _run_wire_pass(hunks, kind, binary, model,
                       verbose=verbose, debug=debug, debug_path=debug_path)
        _merge_wiring_only_clusters(hunks)
        return
    # Grouping fix: merge a core-less cluster into the cluster whose core its links
    # wire (a clustering error the per-cluster seam-build can't bridge). Before
    # _reconcile_wires so the wiring fix sees the merged groups.
    _merge_wiring_only_clusters(hunks)
    # Health fix: let the reliable cluster pass correct noisy link wiring so the
    # report doesn't show spurious dangling links (measured: private-app 3.2 -> 0/run).
    _reconcile_wires(hunks)
