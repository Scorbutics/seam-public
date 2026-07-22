//! Repo walk — port of core/resolve/walk.ts. Git is the source of truth for which files exist (tracked ∪
//! untracked-not-ignored), so we shell to the SAME `git ls-files` the TS side does → byte-identical file set
//! by construction (no re-implemented gitignore semantics). SKIP_DIRS prunes build output / vendored deps.

use std::collections::HashSet;
use std::fs;
use std::process::Command;

// Port of SKIP_DIRS (core/resolve/languages/base.ts) — pruned by NAME at any path depth.
pub const SKIP_DIRS: &[&str] = &[
    "node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv", "out", "target",
    "vendor", ".gradle", "__pycache__",
];

/// normpath (walk.ts): forward slashes, strip a trailing slash (len > 1). Git output is already clean
/// repo-relative, so this is ~identity there.
pub fn normpath(p: &str) -> String {
    let n = p.replace('\\', "/");
    if n.len() > 1 && n.ends_with('/') {
        n[..n.len() - 1].to_string()
    } else {
        n
    }
}

fn git_list(repo: &str, args: &[&str]) -> Option<Vec<String>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["ls-files", "-z"])
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Some(s.split('\0').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect())
}

/// gitNonIgnored (walk.ts): tracked (`--recurse-submodules`) ∪ untracked-not-ignored
/// (`--others --exclude-standard`). None when the dir isn't a git repo / git is absent (→ fs-walk fallback).
pub fn git_non_ignored(repo: &str) -> Option<HashSet<String>> {
    if std::env::var("SEAM_NO_GITIGNORE").as_deref() == Ok("1") {
        return None;
    }
    let tracked = git_list(repo, &["--recurse-submodules"])?;
    let mut set: HashSet<String> = tracked.iter().map(|p| normpath(p)).collect();
    if let Some(others) = git_list(repo, &["--others", "--exclude-standard"]) {
        for p in &others {
            set.insert(normpath(p));
        }
    }
    Some(set)
}

/// A path is pruned if ANY segment is a SKIP_DIR (mirrors walk()'s directory-level pruning).
fn is_skipped(rel: &str) -> bool {
    rel.split('/').any(|seg| SKIP_DIRS.contains(&seg))
}

/// The set of repo-relative source files matching `ext` (e.g. ".java"). ORDER-INDEPENDENT — the callers that
/// consume it (the FQN index) dedupe deterministically, so this returns a bare Vec. Git path when available,
/// else a SKIP_DIRS-pruned filesystem walk (the SEAM_NO_GITIGNORE / non-git fallback).
pub fn repo_files(repo: &str, ext: &str) -> Vec<String> {
    match git_non_ignored(repo) {
        Some(keep) => keep
            .into_iter()
            .filter(|r| r.ends_with(ext) && !is_skipped(r))
            .collect(),
        None => {
            let mut out = Vec::new();
            fs_walk(repo, "", ext, &mut out);
            out
        }
    }
}

fn fs_walk(repo: &str, rel_dir: &str, ext: &str, out: &mut Vec<String>) {
    let abs = if rel_dir.is_empty() {
        repo.to_string()
    } else {
        format!("{repo}/{rel_dir}")
    };
    let Ok(entries) = fs::read_dir(&abs) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let rel = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            fs_walk(repo, &rel, ext, out);
        } else if rel.ends_with(ext) {
            out.push(rel);
        }
    }
}
