"""Classification service — buckets hunks into roles via the Claude Code CLI.

Uses the local `claude` binary in headless mode (`claude -p ... --output-format
json`), which authenticates through the user's Claude Code subscription. No API
key, no per-token billing.

Design choices that matter (see plan):
  - ONE pass over the WHOLE remaining diff, not per-hunk. The model's value here
    is triangulation (§3): core and link only reveal intent *together*. A hunk
    classified in isolation can't be reliably typed.
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
# is reasoning-heavy and the LLM does it best with thinking ON (None = CLI default;
# measured cluster F1 ~1.0). Roling is local and is more accurate AND ~16x faster
# with thinking OFF (0). Tunable: cap CLUSTER_THINKING to trade clustering quality
# for latency once the F1-vs-budget curve is measured via eval/harness.py.
CLUSTER_THINKING: int | None = None
ROLE_THINKING: int | None = 0


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


# Two INDEPENDENT LLM passes, each at its measured-best config, merged by id:
#   Pass A — CLUSTER: thinking ON. Grouping is reasoning-heavy and the LLM does it
#     holistically far better (cluster F1 ~1.0) than any reconstruction from local
#     wiring (deterministic-from-wires measured 0.5–0.7 — rejected).
#   Pass B — SEAM+ROLE: thinking OFF + sharp role defn. Roling is local pattern-
#     matching, more accurate AND ~16x faster without thinking (measured).
# The passes don't depend on each other (roles were accurate WITHOUT cluster
# context), so they could run in parallel. Wires still come from pass B for the
# renderer's intra-cluster seam edges, but no longer carry the partition.

_PROMPT_CLUSTER = """\
You are a STRUCTURING tool for code review. You DECOMPOSE a diff. You do NOT
review, judge, score, or comment on quality.

Your ONLY job in this pass: GROUP the hunks into INTENT CLUSTERS — coherent
sub-changes, using the whole diff as context. A diff often contains several
distinct intents; each becomes one group. Grouping is GRAMMAR-driven (what wires
to what), NOT topic similarity: put a link in the SAME group as the core it wires
in — the joint and the thing it joins belong together. Give each group a stable
id ("g1", "g2", ...) and a short intent label (<= 8 words). One intent = one
group, even if it spans several files.

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
   thing) together with the link(s) that wire THAT core into the system. The core
   ANCHORS the seam; links POINT AT the cores they wire. MANY-TO-MANY:
   - Every CORE hunk anchors its own seam: give it a `seam` id UNIQUE ACROSS THE
     WHOLE DIFF ("s1", "s2", ...) and a short `seam_label` (<= 6 words). Put
     `seam`/`seam_label` ONLY on cores.
   - Every LINK (and environment) hunk lists `wires`: the seam id(s) of the
     core(s) it wires. A link wiring SEVERAL cores lists ALL of them
     ("wires":["s1","s2"]). A truly dangling link has "wires":[].

2) ROLE each hunk. `core` is the SCARCE, expensive role — DEFAULT to link or
   environment and promote to core only when the hunk clears the bar below. A
   typical change has only 1–3 cores (the genuinely new logic the change is ABOUT)
   surrounded by MANY links/environment. If you find yourself marking most hunks
   core, you are wrong — re-read.

   - core: contains the new DECISION / ALGORITHM / behavioral logic that IS the
     point of the change. Test: "if this hunk were subtly wrong, would the
     FEATURE itself be wrong (not just disconnected)?" Only then is it core.
   - link: exists to CONNECT the new thing to existing code — call sites, params
     threaded across layers, signature/interface matches, AND adapter/repository
     implementations that merely fulfill a contract (a DB query or in-memory
     store that backs an interface is a LINK, not core — it wires a data source
     in; the new logic lives elsewhere). Registering a new object into a parent
     is a link.
   - environment: ambient SUPPORT, not logic — new type/interface/field
     declarations, default-initializing a new field, imports/includes, constants,
     globals, config/data values, shared utilities, AND tests (they verify the
     change rather than being it). Trust is impact, not behavior.
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

Return ONLY a JSON array, no prose, no markdown fences. One object per hunk. Do
NOT emit group/intent — those are derived from your wiring.
A MONO-ROLE hunk: a core anchors a seam (seam + seam_label); a link/environment
lists the seam(s) it wires:
[{"id":"h1","role":"core","seam":"s1","seam_label":"gateway call-site","rationale":"<=12 words"},
 {"id":"h2","role":"link","wires":["s1"],"rationale":"<=12 words"}]
A FUSED hunk: omit the top-level role and give `spans` (line ranges over the
gutter numbering):
[{"id":"h3","spans":[
    {"role":"environment","lines":"1-4","rationale":"new imports for gateway"},
    {"role":"core","lines":"5-19","seam":"s2","seam_label":"currency gateway","rationale":"new conversion logic"}]}]
Seam ids are unique across the whole diff. The rationale is a STRUCTURING note,
never a quality judgement.

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


def _build_prompt(hunks: list[Hunk]) -> str:
    """Pass B (seam+role) prompt — bodies gutter-numbered so spans can cite lines.

    NB: pass B is INDEPENDENT of pass A (roles are accurate without cluster
    context; feeding the intent in was measured to NOT help and to over-correct
    toward under-coring, so it was reverted)."""
    parts = [_PROMPT_SEAM_ROLE]
    for h in hunks:
        parts.append(
            f"\n--- HUNK {h.id} | file: {h.file_path} | change: {h.change_type} ---\n"
            f"{_number_body(h.text)}\n"
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
    """Pull the first JSON array out of the model's reply, tolerating stray prose."""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if not m:
        raise ClassifierError(f"No JSON array in model reply: {text[:200]!r}")
    return json.loads(m.group(0))


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
    ON; right for the cluster pass). Copilot ignores it.
    """
    return _run_claude(binary, prompt, model, debug, thinking) if kind == "claude" \
        else _run_copilot(binary, prompt, debug)


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


def _run_copilot(copilot_bin: str, prompt: str, debug: bool = False) -> str:
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
    `wires`/`rationale` are unioned/joined across spans. Seam ids are global here
    (clusters are derived later), so seam_label is keyed by seam id."""
    core = next((s for s in h.spans if s.role == "core"), None)
    primary = core or h.spans[0]
    h.role = primary.role
    h.seam = primary.seam if core else ""
    h.seam_label = (primary.seam_label or seam_label.get(h.seam, "")) if core else ""
    wires: list[str] = []
    for s in h.spans:
        for x in s.wires:
            if x and x not in wires:
                wires.append(x)
    # If a link/env span gave a seam instead of wires, tolerate it like the flat path.
    for s in h.spans:
        if s.role in ("link", "environment") and not s.wires and s.seam and s.seam not in wires:
            wires.append(s.seam)
    h.wires = wires
    h.rationale = " | ".join(f"{s.role}: {s.rationale}" for s in h.spans if s.rationale)


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


def classify(
    hunks: list[Hunk],
    *,
    model: str = "claude-haiku-4-5",
    claude_bin: str | None = None,
    context_window: int = DEFAULT_CONTEXT_WINDOW,
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

    # PASS A — CLUSTER (thinking ON: grouping is the reasoning-heavy, holistic part).
    cluster_labels = _run_pass(kind, binary, cluster_prompt, model,
                               thinking=CLUSTER_THINKING, tag="cluster",
                               verbose=verbose, debug=debug, debug_path=debug_path)
    group_intent: dict[str, str] = {}
    groups: dict[str, tuple[str, str]] = {}
    for hid, item in cluster_labels.items():
        g = str(item.get("group", "")).strip()
        it = str(item.get("intent", "")).strip()
        groups[hid] = (g, it)
        if g and it and g not in group_intent:
            group_intent[g] = it

    # PASS B — SEAM+ROLE (thinking OFF: local pattern-matching, fast + accurate).
    # Independent of pass A (see _build_prompt); merged by id below.
    role_prompt = _build_prompt(hunks)
    labels = _run_pass(kind, binary, role_prompt, model,
                       thinking=ROLE_THINKING, tag="role",
                       verbose=verbose, debug=debug, debug_path=debug_path)
    if debug:
        _dbg(f"cluster pass: {len({g for g, _ in groups.values() if g})} groups; "
             f"role pass: {len(labels)} labelled hunks")

    # Seam labels fallback — seam ids are GLOBAL (cluster ids come from pass A), so
    # key by seam id. A hunk missing its seam_label inherits it from the core that
    # anchors the seam. Scan both flat objects and span objects.
    seam_label: dict[str, str] = {}
    for item in labels.values():
        objs = item.get("spans") if isinstance(item.get("spans"), list) else None
        for src in (objs or [item]):
            if not isinstance(src, dict):
                continue
            s = str(src.get("seam", "")).strip()
            sl = str(src.get("seam_label", "")).strip()
            if s and sl and s not in seam_label:
                seam_label[s] = sl

    for h in hunks:
        # group/intent from PASS A
        g, it = groups.get(h.id, ("", ""))
        h.group = g
        h.intent = it or group_intent.get(g, "")
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
            h.seam = str(item.get("seam", "")).strip()
            # A link/environment lists the seam(s) it wires (many-to-many). Tolerate
            # a model that still emitted the old single `seam` on a link by treating
            # it as wiring that one seam.
            raw = item.get("wires", [])
            wires = [str(x).strip() for x in raw if str(x).strip()] if isinstance(raw, list) else []
            if not wires and role in ("link", "environment") and h.seam:
                wires = [h.seam]
            h.wires = wires
            h.seam_label = (str(item.get("seam_label", "")).strip()
                            or seam_label.get(h.seam, ""))
        else:
            # Unclassified → default to core (heaviest verification = safe direction).
            h.role = "core"
            h.rationale = "unclassified — defaulted to core for review"
