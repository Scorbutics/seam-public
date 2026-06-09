"""P5 — LLM-directional auto-orchestration: GROW a footprint toward answering a question.

The "less precise, automatic" entry ramp (Brice). Seed from a confirmed anchor, then LOOP: show the
LLM the current footprint + the question, let it pick ONE node and a DIRECTION (up = consumers /
down = dependencies) that advances toward the answer, expand+merge, repeat — until it says done or a
step budget. Then decompose with the question so the matching seam is focused. The LLM only CHOOSES
moves over the deterministic primitives (`build_consumers_graph` / `build_dependency_graph`); it
never invents an edge — every node it can pick is already resolved, so the grown graph can't lie.

The action space is the consolidated TWO primitives (up/down), so the model reasons simply; the
engine handles importers-vs-call-sites-vs-class-mode underneath.
"""
from __future__ import annotations

from . import codebase, expand, graph_ir, import_scan, llm


def _summary(data: dict) -> list[dict]:
    """The current footprint as {id, symbol, role, file} — deterministic roles only (fast, no LLM)."""
    g = graph_ir.from_resolved_graph(data)
    codebase.assign_roles(g)
    return [{"id": n.id, "symbol": n.label, "role": n.role, "file": n.file} for n in g.nodes.values()]


def _step_prompt(intent: str, summary: list[dict]) -> str:
    lines = [
        f'A developer asks: "{intent}". You are GROWING a code footprint to answer it.',
        "",
        "Current footprint (symbol — role — file):",
    ]
    for n in summary[:45]:
        lines.append(f"  {n['symbol']} — {n['role']} — {n['file']}")
    lines += [
        "",
        "Pick ONE node to expand toward the answer, and a DIRECTION:",
        "  up   = its CONSUMERS (who uses it: callers, controllers, handlers, tests)",
        "  down = its DEPENDENCIES (what it uses: services, repositories, db)",
        "Pick the single move that best advances toward answering the question. Prefer nodes whose",
        "role/area is on the path to the answer. Set done=true once the footprint already covers the",
        "answer — do NOT over-expand.",
        "",
        'Output ONLY a JSON array with exactly ONE object (use a symbol from the list verbatim):',
        '[{"id":"step","node":"<symbol>","direction":"up|down","done":false}]',
    ]
    return "\n".join(lines)


_MOVE_CAP = 30   # a single move adding more than this is "too broad" (a widely-used class) → skipped


def auto_orchestrate(repo: str, anchor_file: str, symbol: str, intent: str, *, max_steps: int = 4,
                     model: str = "claude-haiku-4-5", claude_bin: str | None = None,
                     verbose: bool = False) -> tuple[dict, list[dict]]:
    """Seed from the anchor, then let the LLM grow the footprint toward `intent` for up to
    `max_steps`. Returns (the grown ResolvedGraph, the move history). A move that would add more than
    `_MOVE_CAP` nodes (expanding a widely-used class) is SKIPPED — it floods the footprint instead of
    advancing the answer. Degrades to whatever it has grown if the LLM is unavailable / unusable."""
    data = import_scan.build_consumers_graph(repo, anchor_file, symbol)
    history: list[dict] = []
    for _ in range(max_steps):
        summary = _summary(data)
        try:
            out = llm.run_pass(_step_prompt(intent, summary), model=model, claude_bin=claude_bin,
                               tag="orchestrate", verbose=verbose)
        except llm.LLMError:
            break
        dec = out.get("step") or next((v for v in out.values() if isinstance(v, dict)), None)
        if not isinstance(dec, dict) or dec.get("done") in (True, "true", "True"):
            break
        node_sym = str(dec.get("node", "")).strip()
        direction = "down" if str(dec.get("direction", "up")).strip().lower().startswith("d") else "up"
        chosen = next((n for n in summary if n["symbol"] == node_sym), None)
        if chosen is None:
            break
        nd = next((x for x in data["nodes"] if x["id"] == chosen["id"]), None)
        if nd is None:
            break
        line = (nd.get("range") or [0])[0]
        try:
            add = (import_scan.build_dependency_graph(repo, nd["file"], nd["symbol"], anchor_line=line)
                   if direction == "down"
                   else import_scan.build_consumers_graph(repo, nd["file"], nd["symbol"], anchor_line=line))
        except Exception:
            break
        # a move that would flood the footprint (a widely-used class' consumers) doesn't advance the
        # answer — skip it and let the LLM try elsewhere, rather than drowning the intent in noise.
        have = {expand._key(x) for x in data["nodes"]}
        new_nodes = sum(1 for n in add["nodes"] if expand._key(n) not in have)
        if new_nodes > _MOVE_CAP:
            history.append({"node": node_sym, "direction": direction, "added": 0, "skipped": f"too broad (+{new_nodes})"})
            continue
        before = len(data["nodes"])
        data = expand.merge_resolved(data, add, expand_anchor=add.get("anchor", {}).get("id"))
        history.append({"node": node_sym, "direction": direction, "added": len(data["nodes"]) - before})
        if history[-1]["added"] == 0:                    # the move reached nothing new (a dead-end)
            break
    return data, history
