"""Service layer for obtaining a unified diff.

Two sources, both producing plain unified-diff text:
  - a local .patch / .diff file
  - a `git diff <ref-range>` run against a local repo

Kept behind this module so the rest of the tool never shells out to git or reads
files directly — swap in PyGithub / another VCS here later without touching callers.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


class DiffSourceError(RuntimeError):
    """Raised when a diff cannot be obtained."""


def from_file(path: str) -> str:
    p = Path(path)
    if not p.is_file():
        raise DiffSourceError(f"Diff file not found: {path}")
    text = p.read_text(encoding="utf-8", errors="replace")
    if not text.strip():
        raise DiffSourceError(f"Diff file is empty: {path}")
    return text


def from_git(ref_range: str, repo: str = ".") -> str:
    """Run `git diff <ref_range>` in `repo` and return the unified diff.

    `ref_range` is passed through verbatim (e.g. "main..HEAD", "HEAD~3..HEAD",
    or even a single ref). We force a clean unified diff with full context off
    by default but renames detected, so the noise filter can see them.
    """
    repo_path = Path(repo)
    if not (repo_path / ".git").exists() and not repo_path.is_dir():
        raise DiffSourceError(f"Not a git repository: {repo}")

    cmd = ["git", "-C", str(repo_path), "diff", "--no-color", "--find-renames", ref_range]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:  # git not installed
        raise DiffSourceError("git executable not found on PATH") from exc

    if proc.returncode != 0:
        raise DiffSourceError(
            f"git diff failed (exit {proc.returncode}): {proc.stderr.strip()}"
        )
    if not proc.stdout.strip():
        raise DiffSourceError(f"git diff produced no output for range: {ref_range}")
    return proc.stdout


def get_diff(file: str | None = None, git: str | None = None, repo: str = ".") -> str:
    """Resolve a diff from whichever source was provided."""
    if file:
        return from_file(file)
    if git:
        return from_git(git, repo=repo)
    raise DiffSourceError("No diff source given: pass --file or --git")
