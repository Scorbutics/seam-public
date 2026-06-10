"""Legacy standalone HTML report (DEPRECATED).

Being wound down in favour of the VS Code extension's native rendering
(`seams.emit_seams_json`). Kept isolated here so the core stays clean while the
report is slowly deprecated. Reuses the shared seam-assembly engine in
`src/seams.py`.
"""

from .html_report import render

__all__ = ["render"]
