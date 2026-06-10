"""Architecture guard — the loose-coupling rule the mode split bought (architecture-modes-plan.md).

THE RULE: `src/diff/*` and `src/codebase/*` are the two product pipelines; they may import from
`src/core/*` (the shared engine) and from within their own folder, but NEVER from each other, and
`core/*` imports neither mode. This keeps the modes independently evolvable/deletable. A violation
here means a cross-mode coupling crept back in — break it (extract the shared bit to `core/`)."""
from __future__ import annotations

import ast
import pathlib

_SRC = pathlib.Path(__file__).resolve().parent.parent / "src"


def _imports(pyfile: pathlib.Path) -> list[str]:
    """Every module path a file imports — absolute (`src.x.y`) and relative (resolved to `src...`)."""
    tree = ast.parse(pyfile.read_text(encoding="utf-8"), filename=str(pyfile))
    pkg = pyfile.relative_to(_SRC.parent).with_suffix("").parts  # ('src','diff','classifier')
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level:                                  # relative: climb `level` from this package
                base = pkg[:-node.level] if node.level <= len(pkg) else ()
                out.append(".".join((*base, node.module) if node.module else base))
            elif node.module:
                out.append(node.module)
        elif isinstance(node, ast.Import):
            out.extend(a.name for a in node.names)
    return out


def _files(folder: str) -> list[pathlib.Path]:
    return list((_SRC / folder).rglob("*.py"))


def test_diff_never_imports_codebase():
    for f in _files("diff"):
        for imp in _imports(f):
            assert not imp.startswith("src.codebase"), f"{f.name} imports {imp} (diff → codebase)"


def test_codebase_never_imports_diff():
    for f in _files("codebase"):
        for imp in _imports(f):
            assert not imp.startswith("src.diff"), f"{f.name} imports {imp} (codebase → diff)"


def test_core_imports_no_mode():
    for f in _files("core"):
        for imp in _imports(f):
            assert not imp.startswith(("src.diff", "src.codebase")), f"core/{f.name} imports {imp}"
