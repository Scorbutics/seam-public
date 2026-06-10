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

import os
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

# A footprint anchors on a behavioural/structural UNIT, never a local variable or a field. Filtering
# to these kills the `roles`/`userRoles`/`allRoles` local-symbol noise workspaceSymbol returns.
_ANCHOR_KINDS = frozenset({"class", "function", "method", "constructor", "interface",
                           "enum", "struct", "namespace"})


def _tokens(s: str) -> list[str]:
    """Tokenise a name / path / phrase into lowercase words: splits camelCase, snake_case, kebab,
    dots and path separators. `getScoringConfig` → [get, scoring, config]; `a/b-c.ts` → [a, b, c, ts]."""
    return [t.lower() for part in re.split(r"[^A-Za-z0-9]+", s) for t in _TOKEN_RE.findall(part)]


def _stem(t: str) -> str:
    """Crude singular stem so a plural intent word matches a singular symbol: `roles`→`role`,
    `classes`→`class`, `repositories`→`repository`. Conservative (length-guarded). The `-es` strip
    only fires for true `-es` plurals (after s/x/z/ch/sh), so `roles`→`role`, not `rol`."""
    if t.endswith("ies") and len(t) > 4:
        return t[:-3] + "y"
    if len(t) > 4 and (t[-3:] in ("ses", "xes", "zes") or t[-4:] in ("ches", "shes")):
        return t[:-2]
    if t.endswith("s") and len(t) > 3:
        return t[:-1]
    return t


def _content_words(intent: str) -> set[str]:
    return {t for t in _tokens(intent) if t not in _STOP and len(t) > 2}


# A class/function/method is the likely behavioural anchor of a footprint; an interface/enum/model
# rarely is — so they rank below, even on an equal name match.
_KIND_BOOST = {"class": 1.5, "struct": 1.5, "function": 1.2, "method": 1.2,
               "interface": 0.6, "namespace": 0.4, "enum": 0.3}


def rank_anchors(intent: str, candidates: list[dict], *, limit: int = 12) -> list[dict]:
    """Return `candidates` (each {name, file, kind, ...}) ordered best-first for `intent`, annotated
    with `score` and the matched `terms`. Filters to ANCHOR kinds (drops local-var/field noise) and
    matches on STEMS (plural↔singular). Candidates with no overlap are dropped UNLESS that would leave
    nothing; the kind filter falls back to the full pool if it would empty it (so there's always a
    pick)."""
    iwords = _content_words(intent)
    istems = {_stem(w) for w in iwords}
    pool = [c for c in candidates if c.get("kind") in _ANCHOR_KINDS] or candidates
    scored: list[dict] = []
    for c in pool:
        name_stems = {_stem(t) for t in _tokens(c.get("name", ""))}
        path_stems = {_stem(t) for t in _tokens(c.get("file", ""))}
        name_hits = istems & name_stems
        path_hits = (istems & path_stems) - name_hits
        score = 3.0 * len(name_hits) + 1.0 * len(path_hits) + _KIND_BOOST.get(c.get("kind", ""), 0.0)
        # surface the ORIGINAL intent words whose stem matched (human-readable)
        terms = sorted({w for w in iwords if _stem(w) in (name_hits | path_hits)})
        scored.append({**c, "score": round(score, 2), "terms": terms})
    scored.sort(key=lambda c: (-c["score"], len(c.get("name", "")), c.get("name", "")))
    matched = [c for c in scored if c["terms"]]
    return (matched or scored)[:limit]


# --------------------------------------------------------------------------- deterministic discovery
# Top-level declarations — the candidate anchors. Found by scanning the repo (grep + regex), NOT the
# language server: `workspaceSymbol` is project-scoped / loaded-state-dependent (the same flakiness
# that made us pivot off LSP find-references), so candidate discovery must be deterministic+offline.
_DECL_RE = re.compile(
    r"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?"
    r"(class|interface|enum|namespace)[ \t]+([A-Za-z_$][\w$]*)"
    r"|^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)"
    r"|^[ \t]*(?:export[ \t]+)?(?:const|let)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*"
    r"(?:async[ \t]+)?(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)[ \t]*=>",
    re.M,
)


def find_anchor_candidates(repo: str, keywords, *, limit: int = 300) -> list[dict]:
    """Deterministically scan `repo` for TOP-LEVEL declarations (class / interface / enum / namespace
    / function / arrow-const) whose name shares a stem with any `keyword` → candidate anchors
    {name, file, kind}. Offline, no language server. A cheap stem-substring prefilter keeps it to the
    files that could match (like the import scan). Methods aren't discovered — you anchor on the
    class/function and class-mode decomposes its methods."""
    from .languages import SOURCE_EXTS as _EXTS
    from .languages.base import SKIP_DIRS as _SKIP_DIRS
    repo = os.path.expanduser(repo)
    kstems = {_stem(k.lower()) for k in keywords if len(k) > 2}
    if not kstems:
        return []
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_EXTS):
                continue
            try:
                text = open(os.path.join(root, fn), encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            low = text.lower()
            if not any(k in low for k in kstems):       # prefilter: stem must appear somewhere
                continue
            rel = os.path.relpath(os.path.join(root, fn), repo)
            for m in _DECL_RE.finditer(text):
                kw, name = (m.group(1), m.group(2)) if m.group(1) else ("function", m.group(3) or m.group(4))
                if not name:
                    continue
                if kstems & {_stem(t) for t in _tokens(name)}:
                    key = (name, rel)
                    if key not in seen:
                        seen.add(key)
                        kind = kw if kw in ("class", "interface", "enum", "namespace") else "function"
                        out.append({"name": name, "file": rel, "kind": kind})
            if len(out) >= limit:
                return out
    return out


def suggest_crossings(repo: str, symbol: str, *, exclude_file: str | None = None, limit: int = 6) -> list[dict]:
    """SUGGESTED boundary crossings (P4): when resolved expansion stops at an abstraction / DI / ORM
    boundary, find in-repo behavioural defs RELATED to `symbol` — an interface's implementation, a
    similarly-named class — as candidate ways to CONTINUE across the layer. These are ASSUMPTIONS
    (symbol match, not resolution), so the caller marks them SUGGESTED. Reuses the deterministic
    anchor scan over the symbol's OWN tokens, so `IRoleRepository` → `RoleRepository`, dropping the
    symbol itself and (usually) its declaring file."""
    cands = find_anchor_candidates(repo, _tokens(symbol))
    out: list[dict] = []
    for c in rank_anchors(symbol, cands):
        if c["name"] == symbol:
            continue                                     # not itself
        if exclude_file and c["file"].replace("\\", "/") == exclude_file.replace("\\", "/"):
            continue
        out.append({"name": c["name"], "file": c["file"], "kind": c["kind"]})
        if len(out) >= limit:
            break
    return out


def main(argv=None) -> int:
    import argparse
    import json
    import sys
    ap = argparse.ArgumentParser(description="Find + rank candidate anchors against a typed intent.")
    ap.add_argument("--intent", required=True, help="the typed intent, OR (with --crossings) a symbol")
    ap.add_argument("--repo", help="scan this repo for candidate anchors (deterministic; preferred)")
    ap.add_argument("--candidates", help="JSON file of pre-gathered candidates [{name,file,kind}] "
                                         "(used if --repo is omitted)")
    ap.add_argument("--crossings", action="store_true",
                    help="P4: emit SUGGESTED boundary CROSSINGS for --intent (a symbol) instead of "
                         "intent ranking (interface→impl etc.); needs --repo")
    ap.add_argument("--exclude-file", help="--crossings: the symbol's own file to exclude")
    ap.add_argument("--out", help="write ranked JSON here (else stdout)")
    a = ap.parse_args(argv)
    if a.crossings:
        if not a.repo:
            print("error: --crossings needs --repo", file=sys.stderr)
            return 2
        ranked = suggest_crossings(a.repo, a.intent, exclude_file=a.exclude_file)
        text = json.dumps(ranked, indent=2)
        if a.out:
            open(a.out, "w", encoding="utf-8").write(text)
            print(f"Crossings: {a.out}  ({len(ranked)} suggestion(s))")
        else:
            print(text)
        return 0
    if a.repo:
        cands = find_anchor_candidates(a.repo, sorted(_content_words(a.intent)))
    elif a.candidates:
        try:
            cands = json.loads(open(a.candidates, encoding="utf-8").read())
        except (OSError, ValueError) as exc:
            print(f"error: could not load candidates: {exc}", file=sys.stderr)
            return 2
    else:
        print("error: pass --repo (scan) or --candidates (pre-gathered)", file=sys.stderr)
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
