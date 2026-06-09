#!/usr/bin/env python3
"""Phase-0 probe: does a DETERMINISTIC named-import scan recover the consumer footprint
that LSP find-references missed (project-scoped) in a monorepo?

The F5 verdict (memory: lsp-references-monorepo-blind): `executeReferenceProvider` returned
1 same-file ref for `getAvailabilityFromSchedule` while a grep found 12 cross-project
consumers. This probe validates the pivot (memory: §11) — discover module-symbol consumers
by scanning named imports — OFFLINE, against a real repo, no F5.

  python eval/import_scan_probe.py --repo ~/dev/cal.com \
      --anchor-file packages/lib/availability.ts --symbol getAvailabilityFromSchedule

Recall = consumer files found. Precision insight = the import SOURCE each match used (so we
can see whether basename-matching pulls in a wrong same-named module). This is the SUGGESTED
candidate layer (text match, can lie); per-site LSP/AST verification promotes to RESOLVED.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.lang import _IMPORT_RE  # reuse the existing import parser (named-block aware)

_SKIP_DIRS = {"node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv"}
_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts")


def _local_name(named_part: str) -> tuple[str, str] | None:
    """'getAvailabilityFromSchedule' -> (imported, local); 'X as Y' -> (X, Y)."""
    p = named_part.strip()
    if not p:
        return None
    if " as " in p:
        imported, local = p.split(" as ", 1)
        return imported.strip(), local.strip()
    return p, p


def scan(repo: str, anchor_file: str, symbol: str) -> dict:
    basename = os.path.splitext(os.path.basename(anchor_file))[0]   # availability.ts -> availability
    anchor_abs = os.path.normpath(os.path.join(repo, anchor_file))
    consumers: list[dict] = []
    near_miss: list[dict] = []   # imports the symbol but from a source whose basename != anchor's
    files_scanned = 0

    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            if not fn.endswith(_EXTS):
                continue
            path = os.path.join(root, fn)
            if os.path.normpath(path) == anchor_abs:
                continue
            files_scanned += 1
            try:
                text = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if symbol not in text:                     # cheap pre-filter
                continue
            for m in _IMPORT_RE.finditer(text):
                named, source = m.group(2), m.group(3)
                if not named:
                    continue
                hit = next((ln for part in named.split(",")
                            if (ln := _local_name(part)) and ln[0] == symbol), None)
                if not hit:
                    continue
                _imported, local = hit
                # count use-sites of the LOCAL binding outside import lines
                uses = len(re.findall(rf"(?<![.\w$]){re.escape(local)}\s*\(", text))
                rel = os.path.relpath(path, repo)
                src_base = source.rstrip("/").split("/")[-1]
                rec = {"file": rel, "source": source, "local": local, "call_sites": uses}
                (consumers if src_base == basename else near_miss).append(rec)
                break   # one import statement per file is enough
    return {"basename": basename, "files_scanned": files_scanned,
            "consumers": consumers, "near_miss": near_miss}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--anchor-file", required=True, help="repo-relative path of the symbol's defining file")
    ap.add_argument("--symbol", required=True)
    a = ap.parse_args(argv)

    r = scan(os.path.expanduser(a.repo), a.anchor_file, a.symbol)
    print(f"=== import-scan probe | {a.symbol} from …/{r['basename']} ===")
    print(f"  files scanned: {r['files_scanned']}")
    print(f"  CONSUMERS (source basename matches): {len(r['consumers'])}")
    for c in sorted(r["consumers"], key=lambda x: x["file"]):
        print(f"    {c['file']}  ←  {c['source']}  ({c['call_sites']} call-site(s))")
    if r["near_miss"]:
        print(f"  NEAR-MISS (same symbol, different source basename — precision watch): {len(r['near_miss'])}")
        for c in sorted(r["near_miss"], key=lambda x: x["file"]):
            print(f"    {c['file']}  ←  {c['source']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
