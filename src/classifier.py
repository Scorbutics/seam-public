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

from . import ROLES
from .parser import Hunk, Span

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


def _thinking_to_effort(thinking: int | None) -> str | None:
    """Map the claude thinking budget onto Copilot's reasoning-effort knob.

    Copilot has no thinking-token budget; its analog is a coarse reasoning effort
    (low|medium|high) on reasoning-capable models (e.g. gpt-5.5). We approximate the
    claude split: cluster pass (thinking ON, None) -> high; role pass (thinking 0)
    -> low; a positive cap -> medium. This is NOT the measured 0-vs-ON regime
    (Copilot has no true "off", its floor is `low`), only the closest knob available.

    Escape hatch for the unknown CLI version on the target machine: set COPILOT_EFFORT
    to pin a fixed level, or to "off"/"none" to omit --effort entirely (older builds
    that lack the flag, or non-reasoning models). Returns None when no flag should be
    passed.
    """
    override = os.environ.get("COPILOT_EFFORT")
    if override is not None:
        level = override.strip().lower()
        return None if level in ("off", "none", "") else level
    if thinking is None:
        return "high"
    if thinking == 0:
        return "low"
    return "medium"

# Self-consistency: the role/seam pass is sampled (no temperature control in the
# CLI), so borderline hunks flip run-to-run. Run it N times and keep the MEDOID
# run (the one most agreeing with the per-hunk modal) — collapses the variance on
# dominant-role hunks to a stable answer, leaving only genuinely 50/50 hunks
# uncertain. The slow thinking cluster pass runs ONCE; only the cheap role pass
# repeats. Set 1 to disable.
ROLE_VOTES = 3


class ClassifierError(RuntimeError):
    pass


def estimate_tokens(text: str) -> int:
    """Cheap char-based token estimate (no tokenizer). Intentionally high."""
    return int(len(text) / _CHARS_PER_TOKEN) + 1


def fits_context(prompt: str, n_hunks: int, context_window: int = DEFAULT_CONTEXT_WINDOW) -> tuple[bool, int, int]:
    """Return (fits, estimated_input_tokens, usable_budget_tokens)."""
    est_in = estimate_tokens(prompt)
    est_out = n_hunks * _OUTPUT_TOKENS_PER_HUNK
    usable = context_window - _SYSTEM_OVERHEAD_TOKENS
    return (est_in + est_out <= usable, est_in, usable)


def _locate_claude() -> str | None:
    """Find the `claude` executable: CLAUDE_BIN env → PATH → newest VSCode ext."""
    env = os.environ.get("CLAUDE_BIN")
    if env and Path(env).is_file():
        return env
    on_path = shutil.which("claude")
    if on_path:
        return on_path
    candidates = sorted((Path.home() / ".vscode" / "extensions").glob(_VSCODE_EXT_GLOB))
    return str(candidates[-1]) if candidates else None  # lexically-last ≈ newest


def _locate_copilot() -> str | None:
    """Find the GitHub Copilot CLI: COPILOT_BIN env → `copilot` on PATH."""
    env = os.environ.get("COPILOT_BIN")
    if env and Path(env).is_file():
        return env
    return shutil.which("copilot")


def resolve_backend(claude_override: str | None = None) -> tuple[str, str]:
    """Pick the LLM backend, preferring Claude, falling back to GitHub Copilot.

    Both run on the user's existing subscription (no API key). Returns
    (kind, binary) where kind is "claude" or "copilot". An explicit
    --claude-bin forces Claude.
    """
    if claude_override:
        if Path(claude_override).is_file():
            return ("claude", claude_override)
        raise ClassifierError(f"--claude-bin not found: {claude_override}")

    claude = _locate_claude()
    if claude:
        return ("claude", claude)

    copilot = _locate_copilot()
    if copilot:
        return ("copilot", copilot)

    raise ClassifierError(
        "Could not find an LLM CLI. Install the `claude` CLI (Claude Code "
        "subscription) or the GitHub `copilot` CLI, put one on PATH, or set "
        "CLAUDE_BIN / COPILOT_BIN."
    )


# Two INDEPENDENT LLM passes, each at its measured-best config, merged by id.
# They also own the two GRAINS OF INTENT (plan §D): Pass A names PRODUCT intent,
# Pass B names TECHNICAL intent.
#   Pass A — CLUSTER (product intent): thinking ON. Grouping is reasoning-heavy and
#     the LLM does it holistically far better (cluster F1 ~1.0) than any
#     reconstruction from local wiring (deterministic-from-wires measured 0.5–0.7
#     — rejected).
#   Pass B — SEAM+ROLE (technical intent): thinking OFF + sharp role defn. Roling is
#     local pattern-matching, more accurate AND ~16x faster without thinking (measured).
# The passes don't depend on each other (roles were accurate WITHOUT cluster
# context), so they could run in parallel. Wires still come from pass B for the
# renderer's intra-cluster seam edges, but no longer carry the partition.

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


def _extract_json_array(text: str) -> list[dict]:
    """Pull the first JSON array out of the model's reply, tolerating stray prose,
    markdown code fences, and a stray leading array before the real one."""
    text = text.strip()
    # Strip a surrounding markdown code fence (```json ... ```), which the model
    # intermittently adds and which breaks both json.loads and the greedy regex.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Greedy first[..]last; if that fails (e.g. a stray "[]" precedes the real
    # array, giving "Extra data"), fall back to the LONGEST array match.
    for pat in (r"\[.*\]", r"\[.*?\]"):
        for m in sorted(re.finditer(pat, text, re.DOTALL),
                        key=lambda mm: len(mm.group(0)), reverse=True):
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                continue
    raise ClassifierError(f"No JSON array in model reply: {text[:200]!r}")


def _dbg(msg: str) -> None:
    print(f"[debug] {msg}", file=sys.stderr)


def _write_debug_file(path: str, content: str) -> None:
    try:
        Path(path).write_text(content, encoding="utf-8")
    except OSError as exc:
        _dbg(f"could not write {path}: {exc}")


def _run_backend(kind: str, binary: str, prompt: str, model: str, debug: bool = False,
                 thinking: int | None = 0) -> str:
    """Run the chosen backend and return the model's raw text reply.

    `thinking` controls the `claude -p` thinking budget: 0 = OFF (fast; right for
    the role pass), a positive int caps it, None = leave the CLI default (thinking
    ON; right for the cluster pass). For Copilot, `thinking` is mapped to the coarse
    --effort knob (see _thinking_to_effort): None -> high, 0 -> low, else medium.
    """
    return _run_claude(binary, prompt, model, debug, thinking) if kind == "claude" \
        else _run_copilot(binary, prompt, debug, thinking)


def _run_claude(claude_bin: str, prompt: str, model: str, debug: bool = False,
                thinking: int | None = 0) -> str:
    # Feed the prompt via stdin, NOT as an argv entry: a large diff easily exceeds
    # the OS ARG_MAX limit (OSError [Errno 7] Argument list too long).
    # --strict-mcp-config ignores ambient MCP servers (their tool schemas add
    #     latency and input tokens we never use).
    cmd = [claude_bin, "-p", "--output-format", "json", "--model", model,
           "--strict-mcp-config"]
    env = dict(os.environ)
    # THINKING control (see _run_backend). The `claude -p` agent defaults interleaved
    # thinking ON, which burns ~15-22K tokens (~160s/call). For the role pass we force
    # it OFF (thinking=0 → ~16x faster, equal/better roles). For the cluster pass we
    # leave it ON (thinking=None → grammar-driven grouping needs the reasoning).
    if thinking is not None:
        env["MAX_THINKING_TOKENS"] = str(thinking)
    proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                          check=False, env=env)
    if proc.returncode != 0:
        raise ClassifierError(
            f"claude CLI failed (exit {proc.returncode}): {proc.stderr.strip()[:300]}"
        )
    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ClassifierError(f"claude CLI did not return JSON: {proc.stdout[:200]!r}") from exc
    if envelope.get("is_error"):
        raise ClassifierError(f"claude CLI reported error: {envelope.get('result')}")
    if debug:
        usage = envelope.get("usage", {})
        _dbg(f"claude: model(s)={list((envelope.get('modelUsage') or {}).keys())} "
             f"think_budget={env.get('MAX_THINKING_TOKENS')} turns={envelope.get('num_turns')} "
             f"in={usage.get('input_tokens')} out={usage.get('output_tokens')} "
             f"duration_ms={envelope.get('duration_ms')} cost_usd={envelope.get('total_cost_usd')}")
        if proc.stderr.strip():
            _dbg(f"claude stderr: {proc.stderr.strip()[:1000]}")
    return envelope.get("result", "")


def _run_copilot(copilot_bin: str, prompt: str, debug: bool = False,
                 thinking: int | None = 0) -> str:
    """Run the GitHub Copilot CLI headless, on the user's Copilot subscription.

    Unlike `claude -p`, the Copilot CLI does NOT read its prompt from stdin — its
    `-p` flag takes the prompt as an argv value. Passing a whole diff there would
    blow ARG_MAX, so instead we write the prompt to a temp file and hand Copilot a
    tiny pointer instructing it to read that file (it can: `--allow-all-tools`
    enables its file-read tool non-interactively). The diff never touches argv, and
    the file is left on disk under `debug` for inspection.

    We let the Copilot subscription pick the model (override with COPILOT_MODEL).
    Copilot prints its answer to stdout; the prompt asks for a bare JSON array and
    `_extract_json_array` tolerates any surrounding chatter, so we return stdout
    as-is.

    `thinking` is mapped to Copilot's coarse --effort knob (see _thinking_to_effort)
    so the two-pass thinking split survives on reasoning-capable models (e.g.
    gpt-5.5): cluster -> high, role -> low. Set COPILOT_EFFORT=off to omit the flag
    on CLI builds that lack it.
    """
    fd, prompt_path = tempfile.mkstemp(prefix="copilot-prompt-", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(prompt)

        pointer = (
            f"Read the file {prompt_path} and follow the instructions it contains "
            f"exactly. Output only what those instructions ask for."
        )
        # -s/--silent: output only the agent's response (no stats/decoration) so
        #   stdout is clean to parse. --no-ask-user: never block on a prompt in
        #   non-interactive use. --allow-all-tools: lets it use the file-read tool.
        cmd = [copilot_bin, "-p", pointer, "-s", "--no-ask-user", "--allow-all-tools"]
        model = os.environ.get("COPILOT_MODEL")
        if model:
            cmd += ["--model", model]
        effort = _thinking_to_effort(thinking)
        if effort:
            cmd += ["--effort", effort]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if debug:
            _dbg(f"copilot: cmd={' '.join(cmd)} exit={proc.returncode}")
            _dbg(f"copilot prompt file: {prompt_path} ({len(prompt)} chars)")
            if proc.stderr.strip():
                _dbg(f"copilot stderr: {proc.stderr.strip()[:1000]}")
        if proc.returncode != 0:
            raise ClassifierError(
                f"copilot CLI failed (exit {proc.returncode}): {proc.stderr.strip()[:300]}"
            )
        if not proc.stdout.strip():
            raise ClassifierError(
                f"copilot CLI returned no output: {proc.stderr.strip()[:200]!r}"
            )
        return proc.stdout
    finally:
        if not debug:
            try:
                os.unlink(prompt_path)
            except OSError:
                pass


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


def _run_pass(kind: str, binary: str, prompt: str, model: str, *,
              thinking: int | None, tag: str, verbose: bool, debug: bool,
              debug_path: str | None) -> dict[str, dict]:
    """Run ONE LLM pass (with one retry on malformed JSON) and return {id: label}.
    `tag` ("cluster"/"role") names the pass for debug dumps; `thinking` is its
    budget (0 off, None = CLI default-on)."""
    if debug and debug_path:
        _write_debug_file(f"{debug_path}.{tag}.prompt.txt", prompt)
    labels: dict[str, dict] = {}
    last_err: Exception | None = None
    for attempt in (1, 2):
        try:
            raw = _run_backend(kind, binary, prompt, model, debug, thinking)
            if debug:
                _dbg(f"=== {tag} reply (attempt {attempt}, {len(raw)} chars) ===")
                print(raw, file=sys.stderr)
                if debug_path:
                    _write_debug_file(f"{debug_path}.{tag}.reply.txt", raw)
            for item in _extract_json_array(raw):
                if isinstance(item, dict) and "id" in item:
                    labels[str(item["id"])] = item
            break
        except (ClassifierError, json.JSONDecodeError) as exc:
            last_err = exc
            if verbose or debug:
                print(f"[classifier] {tag} attempt {attempt} failed: {exc}")
    if not labels and last_err:
        raise ClassifierError(f"{tag} pass failed after retry: {last_err}")
    return labels


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


def _build_reconcile_prompt(targets: list[Hunk], cores: dict[str, Hunk]) -> str:
    """Closed-candidate prune prompt (brief Layer-2): for each over-wired EDIT, which of
    ITS candidate cores does it ACTUALLY depend on, vs merely co-render a shared component."""
    blocks = []
    for h in targets:
        cands = ", ".join(f'{c}="{cores[c].seam_label or c}"' for c in h.wires if c in cores)
        blocks.append(f"EDIT {h.id}  [{h.file_path}]  role={h.role}\n"
                      f"{_reconcile_snippet(h)}\n"
                      f"candidates: {cands}")
    body = "\n---\n".join(blocks)
    return (
        "Some dependency edges in a diff were drawn too broadly. Each EDIT below was linked "
        "to several CANDIDATE targets, but some links are SPURIOUS: the edit merely RENDERS "
        "or IMPORTS a shared component/util that the target also uses — it does not actually "
        "depend on, call, or modify that target.\n\n"
        "For each EDIT, return the subset of candidate ids it ACTUALLY depends on. Keep a "
        "candidate only if the edit calls it, is configured/typed by it, or modifies it; "
        "drop candidates it merely co-renders a shared component with. Returning all, some, "
        "or none is valid — do not invent edges outside the candidate list.\n\n"
        f"{body}\n\n"
        'Output ONLY a JSON array, one object per EDIT: '
        '[{"id":"h6","wires":["h12"]}, ...]'
    )


def reconcile_wiring_llm(work: list[Hunk], *, targets: list[Hunk] | None = None,
                         gate: int = 4, model: str = "claude-haiku-4-5",
                         claude_bin: str | None = None, verbose: bool = False,
                         debug: bool = False, debug_path: str | None = None, **_ignore) -> None:
    """LLM reconcile (tier 3): prune the candidate edges of the genuinely-ambiguous residual
    (hunks the deterministic reconcile pruned but left over-wired) to the real couplings. A
    VALIDATE task on a CLOSED candidate set (where the LLM is reliable), not generation.
    Conservative: only prunes to a non-empty confirmed subset; never strands a hunk. `targets`
    should be the residual from `classifier_det.reconcile_wiring` (legitimate hubs excluded);
    falls back to a count gate only if not supplied."""
    cores = {h.id: h for h in work if h.role == "core"}
    if targets is None:
        targets = [h for h in work if h.role != "core" and len(h.wires) > gate]
    if not targets:
        return
    kind, binary = resolve_backend(claude_bin)
    prompt = _build_reconcile_prompt(targets, cores)
    labels = _run_pass(kind, binary, prompt, model, thinking=0, tag="reconcile",
                       verbose=verbose, debug=debug, debug_path=debug_path)
    pruned = 0
    for h in targets:
        item = labels.get(h.id) or {}
        raw = item.get("wires")
        if not isinstance(raw, list):
            continue
        confirmed = sorted({c for c in raw if c in h.wires and c in cores})
        if confirmed and len(confirmed) < len(h.wires):
            h.wires = confirmed
            pruned += 1
    if verbose:
        print(f"[reconcile] LLM pruned {pruned}/{len(targets)} over-wired hunks", file=sys.stderr)


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
