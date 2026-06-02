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


_PROMPT_HEADER = """\
You are a STRUCTURING tool for code review. You DECOMPOSE a diff. You do NOT
review, judge, score, approve, or comment on quality. You only structure.

Do THREE things, using the whole diff as context:

1) GROUP the hunks into INTENT CLUSTERS — coherent sub-changes. A diff often
   contains several distinct intents; each becomes one group. Grouping is
   GRAMMAR-driven (what wires to what), NOT topic similarity: put a link in the
   SAME group as the core it wires in — the joint and the thing it joins belong
   together. Give each group a stable id ("g1", "g2", ...) and a short intent
   label (<= 8 words). One intent = one group, even if it spans several files.

   PREFER THE FEWEST CLUSTERS that still separate genuinely independent intents.
   Be COARSE, not fine:
   - Introducing one new thing and migrating several call-sites to it is ONE
     intent (one core + its links across many files), NOT one cluster per
     call-site. The migrated call-sites are LINKS in that single cluster.
   - A helper/strategy that exists only to serve a new mechanism belongs in the
     SAME cluster as that mechanism — even if it lives in a different file.
   - Split into separate clusters ONLY when two intents could ship in separate
     PRs without depending on each other. If unsure, MERGE.

2) Within each cluster, SEAM the hunks into core↔link wirings. A seam is ONE
   core (the new/changed thing) together with the link(s) that wire THAT core
   into the system. The core ANCHORS the seam; links POINT AT the cores they
   wire. The relationship is MANY-TO-MANY — this is the key grammar:
   - Every CORE hunk anchors its own seam: give it a `seam` id unique WITHIN its
     cluster ("s1", "s2", ...) and a short `seam_label` (<= 6 words) naming the
     wiring (e.g. "editable-table call-site"). Put `seam`/`seam_label` ONLY on
     cores.
   - Every LINK (and environment) hunk lists `wires`: the seam id(s) of the
     core(s) it wires. A single link that wires SEVERAL cores lists ALL of them
     (e.g. one call-site threading params for two new cores → "wires":["s1","s2"]).
     Do NOT force a shared link into one seam — that is exactly the wiring this
     model must keep. A link appears in every seam it wires.
   - A truly dangling link (wires something changed elsewhere / outside the diff)
     has "wires":[]. A core that nothing in the diff wires is just a seam with no
     links pointing at it. Use these only when genuinely true, not when unsure —
     if a link plausibly wires a core present here, list that core in `wires`.
   Seaming is what lets a reviewer read a core RIGHT NEXT TO the link(s) that
   wire it, including links shared across several cores.

3) ROLE each hunk (roles only make sense together — links tell you where to
   expect cores):
   - core: the new or changed logic the sub-change is fundamentally about.
   - link: the joints wiring the new thing in — params threading across layers,
           call sites, signature/interface matches.
   - environment: ambient ripple — shared utilities, global CSS/config consumed
           elsewhere, cross-cutting concerns touched.
   - noise: formatting/indentation that slipped through — no logical effect.

4) SPANS — when ONE hunk genuinely carries MORE THAN ONE role, split it INSIDE
   the hunk instead of forcing a single label. The hunk's BODY lines are
   gutter-numbered (e.g. "  3| +foo"); a span names a CONTIGUOUS line range in
   that numbering. Typical case: import/include/boilerplate churn (environment)
   sitting right next to new logic (core), or a new function (core) next to a
   call-site edit (link).
   STRONG BIAS: do NOT split. Only emit spans when the roles genuinely DIFFER —
   never to chop one role into pieces. Keep the hunk as ONE seam anchor: AT MOST
   ONE `core` span per hunk; do not invent extra cores just to split. A hunk that
   is one role end-to-end has NO spans (use the flat role). This keeps seams
   meaningful — a seam is a real technical sub-intent, not a fragment.
   Each span carries its own role, line range, and (core→seam/seam_label,
   link/env→wires). Splitting is OPTIONAL and should be the exception.

Return ONLY a JSON array, no prose, no markdown fences. One object per hunk.
A MONO-ROLE hunk: a core anchors a seam (carries seam + seam_label); a
link/environment lists the seam(s) it wires (carries wires):
[{"id":"h1","group":"g1","intent":"add currency to checkout","role":"core","seam":"s1","seam_label":"gateway call-site","rationale":"<=12 words"},
 {"id":"h2","group":"g1","intent":"add currency to checkout","role":"link","wires":["s1"],"rationale":"<=12 words"}]
A FUSED hunk: omit the top-level role and give `spans` (line ranges over the
gutter numbering), each span a {role, lines, rationale, + seam/seam_label or wires}:
[{"id":"h3","group":"g1","intent":"add currency to checkout","spans":[
    {"role":"environment","lines":"1-4","rationale":"new imports for gateway"},
    {"role":"core","lines":"5-19","seam":"s2","seam_label":"currency gateway","rationale":"new conversion logic"}]}]
Every hunk in the same group MUST repeat the same intent string. A link that
wires several cores lists every one of their seam ids in `wires`. The rationale
is a STRUCTURING note (why this role), never a quality judgement.

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
    parts = [_PROMPT_HEADER]
    for h in hunks:
        parts.append(
            f"\n--- HUNK {h.id} | file: {h.file_path} | change: {h.change_type} ---\n"
            f"{_number_body(h.text)}\n"
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


def _run_backend(kind: str, binary: str, prompt: str, model: str, debug: bool = False) -> str:
    """Run the chosen backend and return the model's raw text reply."""
    return _run_claude(binary, prompt, model, debug) if kind == "claude" \
        else _run_copilot(binary, prompt, debug)


def _run_claude(claude_bin: str, prompt: str, model: str, debug: bool = False) -> str:
    # Feed the prompt via stdin, NOT as an argv entry: a large diff easily exceeds
    # the OS ARG_MAX limit (OSError [Errno 7] Argument list too long).
    # --strict-mcp-config ignores ambient MCP servers (their tool schemas add
    #     latency and input tokens we never use).
    cmd = [claude_bin, "-p", "--output-format", "json", "--model", model,
           "--strict-mcp-config"]
    env = dict(os.environ)
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


def _sync_flat_from_spans(h: Hunk, seam_label: dict[tuple[str, str], str]) -> None:
    """Mirror a fused hunk's spans onto the flat role/seam/wires fields so existing
    role-keyed code (renderer, verification) keeps working. The hunk is summarised
    as its core span if it has one (cores drive seams); otherwise its first span.
    `wires`/`rationale` are unioned/joined across spans."""
    core = next((s for s in h.spans if s.role == "core"), None)
    primary = core or h.spans[0]
    h.role = primary.role
    h.seam = primary.seam if core else ""
    h.seam_label = (primary.seam_label
                    or seam_label.get((h.group, h.seam), "")) if core else ""
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
    prompt = _build_prompt(hunks)

    fits, est_in, usable = fits_context(prompt, len(hunks), context_window)
    if verbose:
        shown_model = model if kind == "claude" else (os.environ.get("COPILOT_MODEL") or "copilot default")
        print(f"[classifier] {len(hunks)} hunks -> {kind}: {binary} (model={shown_model})")
        print(f"[classifier] ~{est_in:,} input tokens estimated; ~{usable:,} usable")
    if not fits:
        print(
            f"warning: diff is ~{est_in:,} tokens, near/over the ~{usable:,}-token "
            f"usable budget. The classify pass may truncate or fail. "
            f"Try a narrower --git range, or split the diff (chunking is on the roadmap).",
            file=sys.stderr,
        )

    if debug and debug_path:
        _write_debug_file(f"{debug_path}.prompt.txt", prompt)
        _dbg(f"wrote prompt ({len(prompt)} chars) -> {debug_path}.prompt.txt")

    labels: dict[str, dict] = {}
    last_err: Exception | None = None
    for attempt in (1, 2):  # one retry on malformed JSON
        try:
            raw = _run_backend(kind, binary, prompt, model, debug)
            if debug:
                _dbg(f"=== raw model reply (attempt {attempt}, {len(raw)} chars) ===")
                print(raw, file=sys.stderr)
                _dbg("=== end raw model reply ===")
                if debug_path:
                    _write_debug_file(f"{debug_path}.reply.txt", raw)
            for item in _extract_json_array(raw):
                if isinstance(item, dict) and "id" in item:
                    labels[str(item["id"])] = item
            break
        except (ClassifierError, json.JSONDecodeError) as exc:
            last_err = exc
            if verbose or debug:
                print(f"[classifier] attempt {attempt} failed: {exc}")
    if not labels and last_err:
        raise ClassifierError(f"Classification failed after retry: {last_err}")
    if debug:
        _dbg(f"parsed {len(labels)} labelled hunks from reply")

    # Collect fallback labels so a hunk missing its own label inherits its
    # group's intent / seam's seam_label. Scan both flat objects and span objects.
    group_intent: dict[str, str] = {}
    seam_label: dict[tuple[str, str], str] = {}
    for item in labels.values():
        g = str(item.get("group", "")).strip()
        it = str(item.get("intent", "")).strip()
        if g and it and g not in group_intent:
            group_intent[g] = it
        objs = item.get("spans") if isinstance(item.get("spans"), list) else None
        for src in (objs or [item]):
            if not isinstance(src, dict):
                continue
            s = str(src.get("seam", "")).strip()
            sl = str(src.get("seam_label", "")).strip()
            if g and s and sl and (g, s) not in seam_label:
                seam_label[(g, s)] = sl

    for h in hunks:
        item = labels.get(h.id) or {}
        h.group = str(item.get("group", "")).strip()
        h.intent = str(item.get("intent", "")).strip() or group_intent.get(h.group, "")
        spans = _parse_spans(item)
        if len(spans) >= 2:  # genuinely fused — keep the per-span roles
            h.spans = spans
            _sync_flat_from_spans(h, seam_label)
            continue
        if len(spans) == 1 and str(item.get("role", "")).strip().lower() not in ROLES:
            # A lone span is just a mono-role hunk expressed verbosely — fold it
            # into the flat fields rather than treat the hunk as fused.
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
                            or seam_label.get((h.group, h.seam), ""))
        else:
            # Unclassified → default to core (heaviest verification = safe direction).
            h.role = "core"
            h.rationale = "unclassified — defaulted to core for review"
