"""Phase-progress side-channel — a single sink for "what step is running now".

The decompose pipeline can spend ~2 minutes inside two LLM passes with no output, so
a host (the VS Code extension) needs to know which phase it's in. We emit a one-line,
machine-parseable marker on **stderr** (the non-payload channel — stdout carries the
`--emit-seams` path / text report). The CLI is unaffected: markers read as plain log
lines. A host strips the `PREFIX` and shows the message verbatim.

Markers are unconditional (NOT gated on --verbose): the host always needs them.
"""
from __future__ import annotations

import sys

PREFIX = "@@SEAM_PROGRESS@@"


def emit(message: str) -> None:
    """Announce the phase now starting. `message` is shown to the user verbatim."""
    print(f"{PREFIX} {message}", file=sys.stderr, flush=True)
