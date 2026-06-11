"""Tier-3 of the edge ladder: LLM DISCOVERY → SUGGESTED.

The lowest-trust tier, reached only on the RESIDUAL — couplings neither the deterministic binding
(tier 1, RESOLVED_FULL) nor the string-dispatch heuristic (tier 2, RESOLVED_PARTIAL) could resolve.
The LLM reads the node's source and PROPOSES couplings carried by things a symbol/string scan misses
(camelCase dispatch keys, config keys, event/topic names, framework conventions, dynamic loading).

TWO INVARIANTS keep it honest:
  1. SUGGESTED stays OUT of the resolved spine — these are blind-spot CANDIDATES, never `edges[]`
     (the LLM never mints a RESOLVED edge; it only proposes — graph_ir.assert_resolved_only holds).
  2. GROUNDED, not hallucinated — every proposal's target is matched against a REAL repo entity
     (a module entry or an existing file). The LLM supplies the INSIGHT (this is a coupling), the
     repo supplies the PROOF (the target exists). Ungrounded proposals are dropped.
Recall via the LLM, precision via grounding — the same split as the rest of the resolver.
"""
from __future__ import annotations

import os

from ..core import llm
from . import string_coupling
from ..core.resolve.languages.base import SKIP_DIRS

_PROMPT = """\
You are analysing ONE function to find COUPLINGS to OTHER parts of this codebase that a static
import/symbol analysis CANNOT see — couplings carried by a STRING, runtime dispatch, a config key, an
event/topic name, a framework convention, or dynamic loading. NOT ordinary imports/calls.

FUNCTION (file: {file}):
{snippet}

ALREADY RESOLVED — do NOT repeat these targets:
{resolved}

Output ONLY couplings with CONCRETE textual evidence in the function above. For each, give the TARGET
it couples to: a name or path that should EXIST somewhere in this repo (a module/file/dir/function).
Do NOT invent targets — if you are not pointing at something that plausibly exists in the repo, omit
it. A wrong guess is worse than silence.

Return a JSON array, one object per coupling (empty array if none):
[{{"id":"c1","target":"<repo name or path the evidence refers to>","evidence":"<the literal/snippet>"}}]
"""


def _ground(repo: str, target: str, entry_index: dict[str, list[str]]) -> str | None:
    """Match the LLM's target hint to a REAL repo path, or None. Conservative: a unique module-entry
    by that name, then an exact existing file, then a unique file whose basename matches. No fuzz."""
    if not target:
        return None
    t = target.strip().strip("/").replace("\\", "/")
    base = os.path.splitext(os.path.basename(t))[0]
    hits = entry_index.get(base) or entry_index.get(t)      # a module entry named like the hint
    if hits and len(hits) == 1:
        return hits[0]
    if os.path.isfile(os.path.join(repo, t)):               # the hint is an exact existing path
        return t
    matches: list[str] = []                                  # else a unique file basename match
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if os.path.splitext(f)[0] == base and f.endswith((".ts", ".tsx", ".js", ".jsx", ".py")):
                matches.append(os.path.relpath(os.path.join(root, f), repo))
                if len(matches) > 1:
                    return None                              # ambiguous → don't assert one
    return matches[0] if matches else None


def discover(repo: str, anchor_file: str, file_text: str, lo: int, hi: int, resolved_files: list[str],
             *, model: str = "claude-haiku-4-5", claude_bin: str | None = None, verbose: bool = False,
             run=None) -> list[dict]:
    """Residual couplings the LLM proposes for the node body [lo, hi], GROUNDED to real repo paths.
    Returns SUGGESTED candidates `[{"file","evidence","provenance":"SUGGESTED"}]`. `run` is injectable
    (defaults to the real LLM) so it's testable without a backend. Degrades to [] on any LLM failure."""
    run = run or llm.run_pass
    snippet = "\n".join(file_text.splitlines()[lo:hi + 1])[:4000]
    if not snippet.strip():
        return []
    prompt = _PROMPT.format(file=anchor_file, snippet=snippet,
                            resolved=", ".join(sorted(set(resolved_files))) or "(none)")
    try:
        out = run(prompt, model=model, claude_bin=claude_bin, tag="discover", verbose=verbose)
    except llm.LLMError:
        return []                                            # no backend → silent, the floor stands
    entry_index = string_coupling.module_entry_index(repo, SKIP_DIRS)
    cands: list[dict] = []
    seen: set[str] = set()
    for obj in (out or {}).values():
        if not isinstance(obj, dict):
            continue
        grounded = _ground(repo, str(obj.get("target", "")), entry_index)
        if grounded and grounded != anchor_file and grounded not in resolved_files and grounded not in seen:
            seen.add(grounded)
            cands.append({"file": grounded, "evidence": str(obj.get("evidence", ""))[:160],
                          "provenance": "SUGGESTED"})
    return cands
