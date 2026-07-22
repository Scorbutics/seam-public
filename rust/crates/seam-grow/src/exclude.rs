//! FOOTPRINT EXCLUSION — a P4 prune applied early so an excluded subtree is never re-anchored: drop test files
//! (default) and any node under an `--exclude` dir (matched as a path PREFIX or a whole path SEGMENT). Port of
//! `_makeExclusion`.

use seam_fs::{is_test_file, normpath};
use seam_scan::graph::ResolvedGraph;

/// The exclusion policy for one grow.
pub struct Exclusion {
    exclude_dirs: Vec<String>,
    include_tests: bool,
}

impl Exclusion {
    pub fn new(exclude_dirs: &[String], include_tests: bool) -> Self {
        Self { exclude_dirs: exclude_dirs.iter().map(|d| normpath(&d.replace('\\', "/"))).collect(), include_tests }
    }

    /// Is `file` excluded — a test file (unless includeTests) or under an `--exclude` dir (prefix or whole
    /// segment)? Port of `excludedFile`.
    pub fn excluded_file(&self, file: &str) -> bool {
        if file.is_empty() {
            return false;
        }
        let f = file.replace('\\', "/");
        if !self.include_tests && is_test_file(&f) {
            return true;
        }
        self.exclude_dirs.iter().any(|d| f == *d || f.starts_with(&format!("{d}/")) || f.split('/').any(|seg| seg == d))
    }

    /// Drop excluded (non-anchor) nodes and their edges from `g`, in place. Port of `prune` (blindspots/
    /// unresolved untouched, matching the TS spread).
    pub fn prune(&self, g: &mut ResolvedGraph) {
        if g.nodes.is_empty() {
            return;
        }
        let drop: std::collections::HashSet<String> =
            g.nodes.iter().filter(|n| n.id != "n1" && self.excluded_file(&n.file)).map(|n| n.id.clone()).collect();
        if drop.is_empty() {
            return;
        }
        g.nodes.retain(|n| !drop.contains(&n.id));
        g.edges.retain(|e| !drop.contains(&e.from) && !drop.contains(&e.to));
    }
}
