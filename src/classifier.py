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
from pathlib import Path

from . import ROLES
from .parser import Hunk

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


def find_claude_bin(override: str | None = None) -> str:
    """Locate the `claude` executable.

    Order: explicit override → CLAUDE_BIN env → PATH → newest VSCode extension.
    """
    if override:
        if Path(override).is_file():
            return override
        raise ClassifierError(f"--claude-bin not found: {override}")

    env = os.environ.get("CLAUDE_BIN")
    if env and Path(env).is_file():
        return env

    on_path = shutil.which("claude")
    if on_path:
        return on_path

    ext_root = Path.home() / ".vscode" / "extensions"
    candidates = sorted(ext_root.glob(_VSCODE_EXT_GLOB))
    if candidates:
        return str(candidates[-1])  # lexically-last ≈ newest version

    raise ClassifierError(
        "Could not find the `claude` CLI. Put it on PATH, set CLAUDE_BIN, "
        "or pass --claude-bin /path/to/claude."
    )


_PROMPT_HEADER = """\
You are a STRUCTURING tool for code review. You DECOMPOSE a diff. You do NOT
review, judge, score, approve, or comment on quality. You only structure.

Do TWO things, using the whole diff as context:

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

2) ROLE each hunk within its group (roles only make sense together — links tell
   you where to expect cores):
   - core: the new or changed logic the sub-change is fundamentally about.
   - link: the joints wiring the new thing in — params threading across layers,
           call sites, signature/interface matches.
   - environment: ambient ripple — shared utilities, global CSS/config consumed
           elsewhere, cross-cutting concerns touched.
   - noise: formatting/indentation that slipped through — no logical effect.

Return ONLY a JSON array, no prose, no markdown fences. One object per hunk:
[{"id":"h1","group":"g1","intent":"add currency to checkout","role":"core","rationale":"<=12 words"}]
Every hunk in the same group MUST repeat the same intent string. The rationale
is a STRUCTURING note (why this role), never a quality judgement.

=== HUNKS ===
"""


def _build_prompt(hunks: list[Hunk]) -> str:
    parts = [_PROMPT_HEADER]
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


def _run_claude(prompt: str, claude_bin: str, model: str) -> str:
    # Feed the prompt via stdin, NOT as an argv entry: a large diff easily exceeds
    # the OS ARG_MAX limit (OSError [Errno 7] Argument list too long).
    cmd = [claude_bin, "-p", "--output-format", "json", "--model", model]
    proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, check=False)
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
    return envelope.get("result", "")


def classify(
    hunks: list[Hunk],
    *,
    model: str = "claude-haiku-4-5",
    claude_bin: str | None = None,
    context_window: int = DEFAULT_CONTEXT_WINDOW,
    verbose: bool = False,
) -> None:
    """Fill role/rationale on each hunk in `hunks` (mutates in place).

    `hunks` should already exclude deterministic noise. No-op on empty input.
    """
    if not hunks:
        return

    binary = find_claude_bin(claude_bin)
    prompt = _build_prompt(hunks)

    fits, est_in, usable = fits_context(prompt, len(hunks), context_window)
    if verbose:
        print(f"[classifier] {len(hunks)} hunks -> {binary} (model={model})")
        print(f"[classifier] ~{est_in:,} input tokens estimated; ~{usable:,} usable")
    if not fits:
        print(
            f"warning: diff is ~{est_in:,} tokens, near/over the ~{usable:,}-token "
            f"usable budget for {model}. The classify pass may truncate or fail. "
            f"Try a narrower --git range, or split the diff (chunking is on the roadmap).",
            file=sys.stderr,
        )

    labels: dict[str, dict] = {}
    last_err: Exception | None = None
    for attempt in (1, 2):  # one retry on malformed JSON
        try:
            raw = _run_claude(prompt, binary, model)
            for item in _extract_json_array(raw):
                if isinstance(item, dict) and "id" in item:
                    labels[str(item["id"])] = item
            break
        except (ClassifierError, json.JSONDecodeError) as exc:
            last_err = exc
            if verbose:
                print(f"[classifier] attempt {attempt} failed: {exc}")
    if not labels and last_err:
        raise ClassifierError(f"Classification failed after retry: {last_err}")

    # Collect a fallback intent label per group, so a hunk missing its own
    # `intent` still inherits the group's label.
    group_intent: dict[str, str] = {}
    for item in labels.values():
        g = str(item.get("group", "")).strip()
        it = str(item.get("intent", "")).strip()
        if g and it and g not in group_intent:
            group_intent[g] = it

    for h in hunks:
        item = labels.get(h.id) or {}
        role = str(item.get("role", "")).strip().lower()
        if role in ROLES:
            h.role = role
            h.rationale = str(item.get("rationale", "")).strip()
            h.group = str(item.get("group", "")).strip()
            h.intent = str(item.get("intent", "")).strip() or group_intent.get(h.group, "")
        else:
            # Unclassified → default to core (heaviest verification = safe direction).
            h.role = "core"
            h.rationale = "unclassified — defaulted to core for review"
