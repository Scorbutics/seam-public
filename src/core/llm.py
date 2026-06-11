"""Shared LLM / CLI plumbing — the REAL home (extracted from classifier.py; both modes use it: diff via
`classifier`, codebase via the facade below). Backend resolution, the subprocess call, JSON-array
extraction, retry, debug — ZERO mode knowledge.

THE INVARIANT (why the LLM is allowed at all): in codebase mode the LLM only produces a PROPOSED
PARTITION / LABELS over VERIFIED carriers — it never finds an edge or an atom (those are RESOLVED). A
proposed partition can mis-frame but cannot fabricate a coupling, so it can\'t make the map lie."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


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


class ClassifierError(RuntimeError):
    pass


# --- Host-served LLM passes (a Claude Code skill / spawned subagent answers the prompt) --------
# When a HostBus is installed, the LLM passes do NOT shell out to `claude -p`: each pass's prompt
# is served by the bus instead. This removes the binary-discovery dependency entirely (no PATH, no
# CLAUDE_BIN) — the running Claude Code session is the backend. Used in two phases, the SAME
# deterministic pipeline runs both times (only the bus differs), so the prompt a subagent answers
# in phase 1 is byte-identical to the one phase 2 rebuilds — see the invariant note in decompose.py:
#   emit   — HostBus() with no answers: records every (tag, prompt) and returns "[]", so each pass
#            applies nothing and the run finishes deterministically; we keep the recorded prompts.
#   inject — HostBus(answers={tag: reply}): returns the subagent's reply for each tag.
_HOST_BUS = None


class HostBus:
    """Routes the LLM passes through the host (the running agent / a spawned subagent) instead of
    a `claude -p` subprocess. `answers` maps a pass tag ("cluster"/"reconcile"/…) to the model's
    raw reply; an unseeded tag returns "[]" (emit phase records the prompt and applies nothing)."""

    def __init__(self, answers: dict[str, str] | None = None):
        self.answers = dict(answers or {})
        self.recorded: dict[str, dict] = {}   # tag -> {"prompt","model","thinking"}, insertion order

    def serve(self, tag: str, prompt: str, *, model: str, thinking: int | None) -> str:
        self.recorded[tag] = {"prompt": prompt, "model": model, "thinking": thinking}
        return self.answers.get(tag, "[]")


def set_host_bus(bus: "HostBus | None") -> None:
    global _HOST_BUS
    _HOST_BUS = bus


def get_host_bus() -> "HostBus | None":
    return _HOST_BUS


# --- LLM usage metering (tokens / cost) — surfaced on a Seam action -----------------------------
# The `claude -p` JSON envelope carries per-call usage; we accumulate it process-wide (reset per
# run via reset_usage()) so the CLI summary and the VS Code message can show what a decomposition
# cost. Retries count (they spend tokens). The copilot backend returns no usage block, and host-
# served passes never reach a subprocess — both are simply not recorded, so the meter reflects only
# what `claude -p` actually spent (a host/copilot run shows no usage rather than a misleading 0).
class UsageMeter:
    def __init__(self):
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = 0.0
        self.duration_ms = 0
        self.backends: set[str] = set()

    def record(self, kind: str, usage: dict, cost_usd, duration_ms) -> None:
        self.calls += 1
        self.backends.add(kind)
        # `claude -p` reports prompt-cache tokens separately from `input_tokens`; fold them in so
        # the input total reflects the real prompt size (cost_usd already accounts for them).
        self.input_tokens += (int(usage.get("input_tokens") or 0)
                              + int(usage.get("cache_read_input_tokens") or 0)
                              + int(usage.get("cache_creation_input_tokens") or 0))
        self.output_tokens += int(usage.get("output_tokens") or 0)
        self.cost_usd += float(cost_usd or 0.0)
        self.duration_ms += int(duration_ms or 0)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def as_dict(self) -> dict | None:
        """JSON-serializable usage for the emitted model (None when no metered call ran)."""
        if not self.calls:
            return None
        return {"calls": self.calls, "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens, "total_tokens": self.total_tokens,
                "cost_usd": round(self.cost_usd, 4), "duration_ms": self.duration_ms,
                "backends": sorted(self.backends)}

    def summary(self) -> str:
        """One-line human summary for the CLI, e.g. '2 LLM calls · 9.2k tokens · $0.01 · 23s'."""
        if not self.calls:
            return ""
        parts = [f"{self.calls} LLM call{'s' if self.calls != 1 else ''}"]
        if self.total_tokens:
            parts.append(f"{self.total_tokens / 1000:.1f}k tokens "
                         f"(in {self.input_tokens / 1000:.1f}k / out {self.output_tokens / 1000:.1f}k)")
        if self.cost_usd:
            parts.append(f"${self.cost_usd:.4f}")
        if self.duration_ms:
            parts.append(f"{self.duration_ms / 1000:.0f}s")
        return " · ".join(parts)


_USAGE = UsageMeter()


def reset_usage() -> None:
    """Start a fresh per-run tally (call once at the top of a mode's run())."""
    global _USAGE
    _USAGE = UsageMeter()


def get_usage() -> "UsageMeter":
    return _USAGE


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
    if _HOST_BUS is not None:
        return ("host", "")        # the running session / a subagent serves the pass — no binary
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
    usage = envelope.get("usage", {}) or {}
    _USAGE.record("claude", usage, envelope.get("total_cost_usd"), envelope.get("duration_ms"))
    if debug:
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
            raw = (_HOST_BUS.serve(tag, prompt, model=model, thinking=thinking)
                   if _HOST_BUS is not None
                   else _run_backend(kind, binary, prompt, model, debug, thinking))
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

LLMError = ClassifierError


def available(claude_bin: str | None = None) -> bool:
    """True if an LLM backend (claude / copilot CLI) is reachable — lets callers degrade to the
    deterministic floor when no LLM is configured (offline / CI)."""
    try:
        resolve_backend(claude_bin)
        return True
    except ClassifierError:
        return False


def run_pass(prompt: str, *, model: str = "claude-haiku-4-5", tag: str = "codebase",
             thinking: int | None = 0, claude_bin: str | None = None,
             verbose: bool = False, debug: bool = False, debug_path: str | None = None) -> dict:
    """Run ONE LLM pass and return `{id: object}` parsed from the model\'s JSON array. `thinking=0`
    keeps it fast; raise `LLMError` on failure so callers can fall back to the floor."""
    kind, binary = resolve_backend(claude_bin)
    return _run_pass(kind, binary, prompt, model, thinking=thinking, tag=tag,
                     verbose=verbose, debug=debug, debug_path=debug_path)
