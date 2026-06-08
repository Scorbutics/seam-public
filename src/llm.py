"""Shared LLM plumbing — the codebase product's LLM facade (Model F4, its first consumer).

The claude-/copilot-CLI plumbing already lives, battle-tested, in `classifier` (the diff product):
backend resolution, the subprocess call, JSON-array extraction, retry. Rather than risk
refactoring that working module, this facade RE-EXPORTS it so there is ONE backend path. The
physical home can move here later (then `classifier` would import from here instead).

THE INVARIANT (why the LLM is allowed here at all): in codebase mode the LLM only ever produces a
PROPOSED PARTITION / LABELS — it regroups and names VERIFIED carriers. It never finds an edge or an
atom (those are RESOLVED, from the symbol resolver). A proposed partition can mis-frame but cannot
fabricate a coupling — so it can't make the map lie (plan §1 / the B principle).
"""
from __future__ import annotations

from .classifier import ClassifierError, _run_pass, resolve_backend

LLMError = ClassifierError


def available(claude_bin: str | None = None) -> bool:
    """True if an LLM backend (claude / copilot CLI) is reachable. Lets callers degrade to the
    deterministic floor when no LLM is configured (offline / CI)."""
    try:
        resolve_backend(claude_bin)
        return True
    except ClassifierError:
        return False


def run_pass(prompt: str, *, model: str = "claude-haiku-4-5", tag: str = "codebase",
             thinking: int | None = 0, claude_bin: str | None = None,
             verbose: bool = False, debug: bool = False, debug_path: str | None = None) -> dict:
    """Run ONE LLM pass and return `{id: object}` parsed from the model's JSON array (one object
    per id). `thinking=0` keeps it fast (the codebase partition pass is grouping, not deep
    reasoning); raise `LLMError` on failure so callers can fall back to the floor."""
    kind, binary = resolve_backend(claude_bin)
    return _run_pass(kind, binary, prompt, model, thinking=thinking, tag=tag,
                     verbose=verbose, debug=debug, debug_path=debug_path)
