#!/usr/bin/env python3
"""L4 probe: deterministic symbol-overlap wiring, scored against gold.

Hypothesis: the model UNDER-wires (leaves env/links empty) because it can't tell
from the diff which cores a generic hunk's footprint touches. A symbol does: if
a core DEFINES `BoosterRepository` and a link REFERENCES it, they wire. We build
the wiring purely from shared NEW symbols (the change's own vocabulary) and score
the (link->core) edge F1 vs gold — using GOLD roles so we measure wiring in
isolation from role errors (the ceiling of the symbol signal).

Run: .venv/bin/python eval/symbol_wiring_probe.py
"""
from __future__ import annotations
import json, re, sys, statistics
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
from src import parser  # noqa: E402

CASES = _ROOT / "eval" / "cases"
GOLD = _ROOT / "eval" / "gold"

_IDENT = re.compile(r"[A-Za-z_]\w{2,}")  # >=3 chars to cut noise (id, db, ...)
# Definition patterns across the case languages (TS/Kotlin/Ruby/C++/SQL).
_DEF_PATTERNS = [
    re.compile(r"\b(?:function|class|interface|type|enum)\s+([A-Za-z_]\w*)"),
    re.compile(r"\b(?:const|let|var|val)\s+([A-Za-z_]\w*)"),
    re.compile(r"\b(?:fun|def|object|module)\s+([A-Za-z_]\w*)"),
    re.compile(r"\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_]\w*)"),
    re.compile(r"\b([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>"),  # arrow fn
    re.compile(r"(?i)\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?[\"`']?([A-Za-z_]\w*)"),
    re.compile(r"(?i)\balter\s+table\s+[\"`']?([A-Za-z_]\w*)"),
]
_KW = {"return", "const", "function", "import", "export", "from", "this", "true",
       "false", "null", "void", "async", "await", "new", "class", "interface",
       "type", "enum", "public", "private", "static", "the", "and", "for"}


def _added(text: str) -> str:
    return "\n".join(l[1:] for l in text.splitlines() if l.startswith("+"))


def _defs_refs(text: str) -> tuple[set[str], set[str]]:
    body = _added(text)
    defs: set[str] = set()
    for pat in _DEF_PATTERNS:
        defs.update(pat.findall(body))
    refs = {t for t in _IDENT.findall(body) if t not in _KW}
    return {d for d in defs if d}, refs


def symbol_edges(hunks: list[dict], roles: dict[str, str]) -> set[tuple[str, str]]:
    dr = {h["id"]: _defs_refs(h["text"]) for h in hunks}
    new_vocab = set().union(*(d for d, _ in dr.values())) if dr else set()
    cores = [h["id"] for h in hunks if roles.get(h["id"]) == "core"]
    edges: set[tuple[str, str]] = set()
    for h in hunks:
        hid = h["id"]
        if roles.get(hid) == "core":
            continue
        hdef, href = dr[hid]
        for c in cores:
            cdef, cref = dr[c]
            shared = new_vocab & ((cdef & href) | (hdef & cref))
            if shared:
                edges.add((hid, c))
    return edges


def gold_edges(gold: list[dict]) -> set[tuple[str, str]]:
    seam2core: dict[str, set[str]] = {}
    for h in gold:
        if h.get("role") == "core" and h.get("seam"):
            seam2core.setdefault(h["seam"], set()).add(h["id"])
    edges: set[tuple[str, str]] = set()
    for h in gold:
        if h.get("role") == "core":
            continue
        for s in (h.get("wires") or []):
            for c in seam2core.get(s, ()):
                edges.add((h["id"], c))
    return edges


def f1(pred: set, gold: set) -> tuple[float, float, float]:
    tp, fp, fn = len(pred & gold), len(pred - gold), len(gold - pred)
    p = tp / (tp + fp) if (tp + fp) else 1.0
    r = tp / (tp + fn) if (tp + fn) else 1.0
    return p, r, (2 * p * r / (p + r) if (p + r) else 0.0)


def main() -> int:
    f1s = []
    print(f"{'case':28} {'prec':>6} {'rec':>6} {'F1':>6}   (gold roles, symbol wiring)")
    for patch in sorted(CASES.glob("*.patch")):
        gold_path = GOLD / f"{patch.stem}.json"
        if not gold_path.exists():
            continue
        gold = json.loads(gold_path.read_text())
        roles = {h["id"]: h.get("role") for h in gold}
        hunks = [{"id": h.id, "text": h.text} for h in parser.parse(patch.read_text())]
        pred = symbol_edges(hunks, roles)
        ge = gold_edges(gold)
        p, r, f = f1(pred, ge)
        f1s.append(f)
        print(f"{patch.stem:28} {p:6.3f} {r:6.3f} {f:6.3f}")
    print(f"{'MEAN':28} {'':>6} {'':>6} {statistics.mean(f1s):6.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
