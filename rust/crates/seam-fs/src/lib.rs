//! Repo file enumeration — port of core/resolve/walk.ts. A sorted, pre-order filesystem DFS (a directory's
//! files, sorted, BEFORE its subdirs), with `git ls-files` (tracked ∪ untracked-not-ignored) as the include
//! FILTER — not the enumerator. This preserves the exact traversal ORDER TS produces, which downstream
//! consumers (e.g. the consumer scan) are order-sensitive to; git provides gitignore semantics without
//! re-implementing them. SKIP_DIRS prunes build output / vendored deps.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;
use std::fs;
use std::process::Command;

static TEST_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(\.(test|spec|e2e|e2e-spec|integration|integration-test)\.[a-z0-9]+$)|(-(test|spec|e2e)\.[a-z0-9]+$)|([-_.](testing|fixture|mock)\.[a-z0-9]+$)|((^|/)(tests?|__tests__|__mocks__|mocks?|fixtures?|testing|spec|e2e|cypress|playwright)/)|((^|/)seed[-_.][^/]*$)").unwrap()
});

/// Does `f` look like a test/fixture/mock file? (port of `isTestFile`, core/resolve/consumers.ts).
pub fn is_test_file(f: &str) -> bool {
    TEST_RE.is_match(&f.replace('\\', "/"))
}

// Port of SKIP_DIRS (core/resolve/languages/base.ts) — pruned by NAME at any path depth.
pub const SKIP_DIRS: &[&str] = &[
    "node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv", "out", "target",
    "vendor", ".gradle", "__pycache__", ".yarn",
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

/// GIT LINEAGE — the "why" layer, scoped to a footprint rather than indexed repo-wide. For each file, the
/// commit that last touched it: short SHA + subject (the human INTENT behind the code) + author + date.
/// Deterministic: git is ground truth, no model, no variance. An LLM consumer reads "this seam was last
/// changed by 3e43d16 'feat: edit referral members'" as provenance it can trust, not a retrieval guess.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lineage {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

/// One `git log -1` per unique file, scoped to the repo. Files are returned in INPUT order (deduped), and a
/// file git cannot resolve — untracked, not a git repo, git absent — is simply ABSENT from the result rather
/// than present-and-empty. The caller then emits nothing for it, so a non-repo (the oracle fixtures) degrades
/// to no lineage instead of to a wrong one. Port of `git_lineage`.
pub fn git_lineage(repo: &str, files: &[String]) -> Vec<(String, Lineage)> {
    let cwd = expanduser(repo);
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for file in files.iter().filter(|f| !f.is_empty()) {
        if !seen.insert(file.as_str()) {
            continue;
        }
        // \x1f (unit separator) as the field delimiter: it cannot occur in a commit subject, so a subject
        // containing tabs, pipes or commas still parses. Only the FIRST line is read — `%s` is the subject
        // alone, but a defensive split keeps a multi-line surprise from corrupting the record.
        let r = std::process::Command::new("git")
            .args(["-C", &cwd, "log", "-1", "--no-color", "--format=%h%x1f%s%x1f%an%x1f%as", "--", file])
            .output();
        let Ok(r) = r else { continue };
        if !r.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&r.stdout);
        let Some(line) = stdout.lines().next().filter(|l| !l.is_empty()) else { continue };
        let mut parts = line.split('\x1f');
        let (sha, subject) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if sha.is_empty() || subject.is_empty() {
            continue;
        }
        out.push((
            file.clone(),
            Lineage {
                sha: sha.to_string(),
                subject: subject.to_string(),
                author: parts.next().unwrap_or("").to_string(),
                date: parts.next().unwrap_or("").to_string(),
            },
        ));
    }
    out
}

fn expanduser(p: &str) -> String {
    match p.strip_prefix('~') {
        Some(rest) => format!("{}{rest}", std::env::var("HOME").unwrap_or_default()),
        None => p.to_string(),
    }
}

#[cfg(test)]
mod lineage_tests {
    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) -> bool {
        std::process::Command::new("git")
            .args(["-C", dir.to_str().unwrap()])
            .args(args)
            .env("GIT_AUTHOR_NAME", "Ada")
            .env("GIT_AUTHOR_EMAIL", "ada@example.com")
            .env("GIT_COMMITTER_NAME", "Ada")
            .env("GIT_COMMITTER_EMAIL", "ada@example.com")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    // THE FUNCTIONAL PATH, which the TypeScript test could not reach: it called `git_lineage(".")` against
    // whatever repo the suite happened to run in, so it could only assert the degradation contract. A real
    // repo built in a temp dir makes the actual answer — sha, subject, author — assertable and hermetic.
    #[test]
    fn the_last_commit_that_touched_a_file_is_reported_with_its_subject() {
        let dir = std::env::temp_dir().join(format!("seam-lineage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if !git(&dir, &["init", "-q"]) {
            return; // no git on this box → the degradation test below still covers the safety contract
        }
        std::fs::write(dir.join("a.ts"), "export const a = 1;\n").unwrap();
        std::fs::write(dir.join("b.ts"), "export const b = 2;\n").unwrap();
        assert!(git(&dir, &["add", "."]));
        // a subject with a pipe and a comma — the \x1f delimiter has to survive punctuation a naive
        // separator would split on
        assert!(git(&dir, &["commit", "-q", "-m", "feat: edit referral members | phase 1, part 2"]));

        let repo = dir.to_string_lossy().to_string();
        let got = git_lineage(&repo, &["a.ts".to_string(), "b.ts".to_string()]);
        assert_eq!(got.len(), 2);
        let (file, lin) = &got[0];
        assert_eq!(file, "a.ts", "input order is preserved");
        assert_eq!(lin.subject, "feat: edit referral members | phase 1, part 2");
        assert_eq!(lin.author, "Ada");
        assert!(!lin.sha.is_empty() && lin.sha.len() < 20, "short sha: {}", lin.sha);
        assert_eq!(lin.date.len(), 10, "%as is YYYY-MM-DD: {}", lin.date);

        // an UNTRACKED file in a real repo is absent, not present-and-empty — the caller emits nothing for
        // it rather than emitting a blank provenance line
        let mixed = git_lineage(&repo, &["a.ts".to_string(), "never-added.ts".to_string()]);
        assert_eq!(mixed.len(), 1);
        assert_eq!(mixed[0].0, "a.ts");

        // duplicates collapse — one `git log` per unique file is the whole cost model
        let dupes = git_lineage(&repo, &["a.ts".to_string(), "a.ts".to_string(), String::new()]);
        assert_eq!(dupes.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // THE SAFETY CONTRACT, ported from `lineage.test.ts`: off a repo this must return nothing and never
    // fail. It is what keeps the oracle fixtures — which are not git repos — byte-identical.
    #[test]
    fn a_non_repo_yields_no_lineage_rather_than_an_error() {
        let absent = std::env::temp_dir().join(format!("seam-lineage-absent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&absent);
        assert!(git_lineage(absent.to_str().unwrap(), &["a.ts".to_string(), "b.ts".to_string()]).is_empty());
    }
}

// ── SEAM_DEBUG — the one diagnostic switch ────────────────────────────────────────────────────────────────
//
// Replaces the per-topic flags (SEAM_PERF, SEAM_FP_DEBUG, SEAM_BORDER_WHY, SEAM_TIER_WHY, SEAM_WAVE_WHY,
// SEAM_VERBOSE_TIER). One comma-separated list of topics, each optionally carrying a value:
//
//     SEAM_DEBUG=perf,wave            two topics on
//     SEAM_DEBUG=border=BookingsBean  a topic with a filter (the old SEAM_BORDER_WHY=<substring>)
//     SEAM_DEBUG=all                  everything
//
// NOTE the name is load-bearing: `seam_env_snapshot`'s `is_diag` treats any key ending `_DEBUG` as
// observability-only and EXCLUDES it from the grow cache key. `SEAM_DEBUG` ends with `_DEBUG`, so turning
// diagnostics on does not silently bust the cache — which is exactly what the per-topic flags did NOT all
// get right (SEAM_BORDER_WHY, SEAM_TIER_WHY and SEAM_WAVE_WHY were all cache-key inputs).
fn debug_spec() -> Option<String> {
    std::env::var("SEAM_DEBUG").ok().filter(|s| !s.trim().is_empty())
}

// The parse is a PURE function of the spec string so it is testable without touching process-global env
// (which would race across parallel test threads).
fn spec_on(spec: &str, topic: &str) -> bool {
    spec.split(',').any(|p| {
        let name = p.trim().split('=').next().unwrap_or("").trim();
        name == "all" || name == topic
    })
}

fn spec_value(spec: &str, topic: &str) -> Option<String> {
    for p in spec.split(',') {
        let mut it = p.trim().splitn(2, '=');
        let name = it.next().unwrap_or("").trim();
        if name == topic {
            return Some(it.next().unwrap_or("").trim().to_string());
        }
        if name == "all" {
            return Some(String::new());
        }
    }
    None
}

/// Is `topic` enabled? `SEAM_DEBUG=all` enables everything.
pub fn debug_on(topic: &str) -> bool {
    debug_spec().map(|s| spec_on(&s, topic)).unwrap_or(false)
}

/// The value attached to `topic` (`border=Foo` -> `Some("Foo")`), or `Some("")` when the topic is bare and
/// enabled, or `None` when it is off.
pub fn debug_value(topic: &str) -> Option<String> {
    debug_spec().and_then(|s| spec_value(&s, topic))
}

#[cfg(test)]
mod debug_tests {
    use super::*;

    #[test]
    fn a_topic_list_enables_each_topic_and_nothing_else() {
        assert!(spec_on("fp", "fp"));
        assert!(spec_on("fp,wave", "wave"));
        assert!(!spec_on("perf", "fp"));
        assert!(!spec_on("", "fp"));
        assert!(spec_on(" fp , wave ", "wave"), "surrounding whitespace must not defeat a topic");
    }

    #[test]
    fn all_enables_every_topic_including_ones_not_named() {
        assert!(spec_on("all", "anything"));
        assert_eq!(spec_value("all", "border").as_deref(), Some(""));
    }

    #[test]
    fn a_topic_can_carry_a_value_the_old_border_why_filter() {
        assert_eq!(spec_value("border=BookingsBean", "border").as_deref(), Some("BookingsBean"));
        // a bare enabled topic yields Some("") -- distinguishable from None (off), which is what lets a
        // value-carrying topic also work as a plain on/off switch
        assert_eq!(spec_value("border", "border").as_deref(), Some(""));
        assert_eq!(spec_value("perf", "border"), None);
    }

    #[test]
    fn a_value_containing_an_equals_sign_survives_intact() {
        // splitn(2) -- otherwise a path or expression filter would be truncated at its first `=`
        assert_eq!(spec_value("border=a=b", "border").as_deref(), Some("a=b"));
    }
}
