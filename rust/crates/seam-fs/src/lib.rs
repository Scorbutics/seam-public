//! Repo file enumeration — port of core/resolve/walk.ts. A sorted, pre-order filesystem DFS (a directory's
//! files, sorted, BEFORE its subdirs), with `git ls-files` (tracked ∪ untracked-not-ignored) as the include
//! FILTER — not the enumerator. This preserves the exact traversal ORDER TS produces, which downstream
//! consumers (e.g. the consumer scan) are order-sensitive to; git provides gitignore semantics without
//! re-implementing them. SKIP_DIRS prunes build output / vendored deps.

use std::collections::HashSet;
use std::fs;
use std::process::Command;

// Port of SKIP_DIRS (core/resolve/languages/base.ts) — pruned by NAME at any path depth.
pub const SKIP_DIRS: &[&str] = &[
    "node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv", "out", "target",
    "vendor", ".gradle", "__pycache__",
];

/// node `path.posix.dirname` — the directory part (trailing slashes ignored; "." when there's no slash).
pub fn dirname(p: &str) -> String {
    let end = p.trim_end_matches('/');
    if end.is_empty() {
        return if p.starts_with('/') { "/".into() } else { ".".into() };
    }
    match end.rfind('/') {
        None => ".".into(),
        Some(0) => "/".into(),
        Some(i) => end[..i].to_string(),
    }
}

/// node `path.posix.normalize` — collapse `.`/`..`/`//`; preserve a leading `/` and a trailing `/`.
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let is_abs = p.starts_with('/');
    let trailing = p.len() > 1 && p.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|&l| l != "..") {
                    out.pop();
                } else if !is_abs {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut s = out.join("/");
    if is_abs {
        s.insert(0, '/');
    }
    if s.is_empty() {
        s = if is_abs { "/".into() } else { ".".into() };
    }
    if trailing && s != "/" {
        s.push('/');
    }
    s
}

/// node `path.posix.join(a, b)` — concatenate then normalize.
pub fn join(a: &str, b: &str) -> String {
    if a.is_empty() {
        return normalize(b);
    }
    if b.is_empty() {
        return normalize(a);
    }
    normalize(&format!("{a}/{b}"))
}

/// Is `repo/rel` a regular file?
pub fn is_file(repo: &str, rel: &str) -> bool {
    std::fs::metadata(format!("{repo}/{rel}")).map(|m| m.is_file()).unwrap_or(false)
}

/// basename without its final extension (port of `stem`, ast_units.ts): a dot at index 0 is not an extension.
pub fn stem(p: &str) -> String {
    let base = p.rsplit('/').next().unwrap_or(p);
    match base.rfind('.') {
        Some(d) if d > 0 => base[..d].to_string(),
        _ => base.to_string(),
    }
}

/// normpath (walk.ts): forward slashes, strip a trailing slash (len > 1).
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
    Some(s.split('\0').filter(|x| !x.is_empty()).map(str::to_string).collect())
}

/// gitNonIgnored (walk.ts): tracked ∪ untracked-not-ignored. `None` when not a git repo / git absent
/// (→ no filtering — the whole tree is walked, minus SKIP_DIRS).
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

// Every ancestor directory (repo-relative) of a kept file — lets the walk prune an entirely-ignored dir
// without descending into it (port of liveDirsOf).
fn live_dirs_of(files: &HashSet<String>) -> HashSet<String> {
    let mut dirs = HashSet::new();
    for f in files {
        let mut i = f.rfind('/');
        while let Some(idx) = i {
            if idx == 0 {
                break;
            }
            let d = &f[..idx];
            if dirs.contains(d) {
                break;
            }
            dirs.insert(d.to_string());
            i = d.rfind('/');
        }
    }
    dirs
}

/// Repo-relative source files matching `pred`, in TS walk order (sorted pre-order DFS, files before subdirs).
pub fn source_files(repo: &str, pred: impl Fn(&str) -> bool) -> Vec<String> {
    let keep = git_non_ignored(repo);
    let live = keep.as_ref().map(live_dirs_of);
    let mut out = Vec::new();
    walk_dir(repo, "", keep.as_ref(), live.as_ref(), &pred, &mut out);
    out
}

/// Convenience: all files with a given extension (e.g. ".java"), in walk order.
pub fn repo_files(repo: &str, ext: &str) -> Vec<String> {
    source_files(repo, |r| r.ends_with(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_path_parity() {
        assert_eq!(dirname("a/b/c.ts"), "a/b");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("a/"), ".");
        assert_eq!(normalize("a/./b"), "a/b");
        assert_eq!(normalize("a/../b"), "b");
        assert_eq!(normalize("../a"), "../a");
        assert_eq!(normalize("a//b"), "a/b");
        assert_eq!(normalize("/x/../y"), "/y");
        assert_eq!(join("a/b/c", "../../x"), "a/x");
        assert_eq!(join("a/b", "./c.js"), "a/b/c.js");
        assert_eq!(stem("d/Foo.java"), "Foo");
        assert_eq!(stem(".gitignore"), ".gitignore");
    }
}

fn walk_dir(
    repo: &str,
    rel_dir: &str,
    keep: Option<&HashSet<String>>,
    live: Option<&HashSet<String>>,
    pred: &impl Fn(&str) -> bool,
    out: &mut Vec<String>,
) {
    let abs = if rel_dir.is_empty() {
        repo.to_string()
    } else {
        format!("{repo}/{rel_dir}")
    };
    let Ok(rd) = fs::read_dir(&abs) else {
        return;
    };
    // sort entries by name ascending (matches TS `entries.sort`); files are emitted before subdirs.
    let mut entries: Vec<(String, bool)> = rd
        .flatten()
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                e.file_type().map(|t| t.is_dir()).unwrap_or(false),
            )
        })
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut subdirs = Vec::new();
    for (name, is_dir) in &entries {
        let rel = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        if *is_dir {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if let Some(ld) = live {
                if !rel.is_empty() && !ld.contains(&rel) {
                    continue; // gitignored dir → don't descend
                }
            }
            subdirs.push(rel);
        } else {
            if let Some(k) = keep {
                if !k.contains(&rel) {
                    continue; // gitignored file
                }
            }
            if pred(&rel) {
                out.push(rel);
            }
        }
    }
    for rel in subdirs {
        walk_dir(repo, &rel, keep, live, pred, out);
    }
}
