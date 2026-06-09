"""Fuzzy entry ramp (plan §1 / P3): rank candidate anchors against a typed INTENT.

The brief's second entry ramp: the user types an intent ("how does scoring work"); the extension
gathers candidate symbols via `workspaceSymbol`; THIS module ranks them so the right anchor is one
glance away (the §6-style gate: confirmation, not a hunt). Ranking is deterministic and offline —
the LSP/UI glue (gather + quick-pick + confirm) stays in the extension. The deterministic footprint
guarantee attaches only AFTER the user confirms a candidate (the brief's invariant).

Signal: overlap of the intent's CONTENT words with a candidate's tokenised name (strong) and file
path / feature area (weak), plus a small kind boost (a class/function/method anchors a footprint;
a variable rarely does). Name + path are tokenised the same way (camelCase / snake / path split),
so "scoring" matches `getScoringConfig`, `scoring.service.ts`, and `features/scoring/`.
"""
from __future__ import annotations

import re

# English filler + code-generic words that carry no anchor signal (so "how does scoring work"
# ranks on "scoring", not "how"/"work"). Kept small + general (no domain terms).
_STOP = frozenset("""
a an the this that these those of for to in on at by with from into over as is are be been being
do does did how what where when which who why whose whom can could should would will shall may might
and or not no yes it its their his her our your my me you we they them work works working use used
using get set make made handle process run call code function method class file module
""".split())

_TOKEN_RE = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")


def _tokens(s: str) -> list[str]:
    """Tokenise a name / path / phrase into lowercase words: splits camelCase, snake_case, kebab,
    dots and path separators. `getScoringConfig` → [get, scoring, config]; `a/b-c.ts` → [a, b, c, ts]."""
    return [t.lower() for part in re.split(r"[^A-Za-z0-9]+", s) for t in _TOKEN_RE.findall(part)]


def _content_words(intent: str) -> set[str]:
    return {t for t in _tokens(intent) if t not in _STOP and len(t) > 2}


_KIND_BOOST = {"class": 1.5, "interface": 1.5, "struct": 1.5, "function": 1.0,
               "method": 1.0, "namespace": 0.5, "enum": 0.5}


def rank_anchors(intent: str, candidates: list[dict], *, limit: int = 12) -> list[dict]:
    """Return `candidates` (each {name, file, kind, ...}) ordered best-first for `intent`, annotated
    with `score` and the matched `terms`. Candidates with no content-word overlap are dropped UNLESS
    that would leave nothing (then the raw list is returned so the user still has something to pick)."""
    iwords = _content_words(intent)
    scored: list[dict] = []
    for c in candidates:
        name_toks = set(_tokens(c.get("name", "")))
        path_toks = set(_tokens(c.get("file", "")))
        name_hits = iwords & name_toks
        path_hits = (iwords & path_toks) - name_hits
        score = 3.0 * len(name_hits) + 1.0 * len(path_hits) + _KIND_BOOST.get(c.get("kind", ""), 0.0)
        scored.append({**c, "score": round(score, 2), "terms": sorted(name_hits | path_hits)})
    scored.sort(key=lambda c: (-c["score"], len(c.get("name", "")), c.get("name", "")))
    matched = [c for c in scored if c["terms"]]
    return (matched or scored)[:limit]


def main(argv=None) -> int:
    import argparse
    import json
    import sys
    ap = argparse.ArgumentParser(description="Rank candidate anchors against a typed intent.")
    ap.add_argument("--intent", required=True)
    ap.add_argument("--candidates", required=True, help="JSON file: [{name, file, kind}, …]")
    ap.add_argument("--out", help="write ranked JSON here (else stdout)")
    a = ap.parse_args(argv)
    try:
        cands = json.loads(open(a.candidates, encoding="utf-8").read())
    except (OSError, ValueError) as exc:
        print(f"error: could not load candidates: {exc}", file=sys.stderr)
        return 2
    ranked = rank_anchors(a.intent, cands)
    text = json.dumps(ranked, indent=2)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text)
        print(f"Ranked: {a.out}  ({len(ranked)} candidate(s))")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
