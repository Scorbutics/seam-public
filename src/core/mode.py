"""The Mode strategy — how the CLI routes a run to a pipeline without knowing either pipeline.

Each mode (`diff.run.MODE`, `codebase.run.MODE`) implements `claims(args)` (do these CLI args belong
to me?) and `run(args)` (do the work, return an exit code). `core/` must NOT import a mode (the
architecture guard), so the concrete registry is assembled by the CLI (`decompose.py`), which imports
both and passes them here. Adding a mode = a new `Mode` + one registry line; no core surgery."""
from __future__ import annotations

from typing import Protocol, Sequence


class Mode(Protocol):
    name: str

    def claims(self, args) -> bool:
        """True if this mode owns the given parsed CLI args (checked in registry order)."""
        ...

    def run(self, args) -> int:
        """Execute the pipeline and return a process exit code."""
        ...


def dispatch(modes: Sequence[Mode], args) -> int:
    """Route `args` to the first mode that claims them. Order matters: put the specific modes before
    the fallback. Raises if none claims (shouldn't happen — the fallback mode claims everything)."""
    for mode in modes:
        if mode.claims(args):
            return mode.run(args)
    raise SystemExit("no mode claimed these arguments")
