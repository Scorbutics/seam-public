//! The repo import index — port of `_repoImports` + the by-name inversion of `_importIndex` (consumers.ts),
//! split out as its own value type. TS fused the walk, the per-file parse, the inversion, and the consumer
//! scan into one file behind module-global caches; here the index is a plain immutable value the `Workspace`
//! owns and builds once. Language-agnostic: it dispatches to each file's provider for its imports.

use seam_lang::{provider_for, ImportRef};
use std::collections::{HashMap, HashSet};

/// One source file's import contribution.
pub struct FileImports {
    pub rel: String,
    /// normpath(repo/rel) — the absolute-normalized path, used to skip the anchor's own file during a scan.
    pub norm: String,
    pub refs: Vec<ImportRef>,
}

/// binding name → the files importing something under that name; plus the per-file contributions. Built in
/// walk order, so the by-name lists preserve the traversal order the consumer scan is byte-identical to.
pub struct ImportIndex {
    files: Vec<FileImports>,
    by_name: HashMap<String, Vec<usize>>,
}

impl ImportIndex {
    pub fn build(repo: &str) -> Self {
        let mut files = Vec::new();
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for rel in seam_fs::source_files(repo, |r| provider_for(r).is_some()) {
            let Some(provider) = provider_for(&rel) else {
                continue;
            };
            let Some(text) = read_text(repo, &rel) else {
                continue; // unreadable → skipped, exactly like walkFiles' try/catch
            };
            let refs = provider.imports(&text);
            let idx = files.len();
            let mut seen = HashSet::new(); // one entry per (file, distinct binding name)
            for r in &refs {
                if seen.insert(r.name.clone()) {
                    by_name.entry(r.name.clone()).or_default().push(idx);
                }
            }
            let norm = seam_fs::normpath(&format!("{repo}/{rel}"));
            files.push(FileImports { rel, norm, refs });
        }
        Self { files, by_name }
    }

    /// The files importing a binding named `name`, in walk order.
    pub fn by_name(&self, name: &str) -> impl Iterator<Item = &FileImports> + '_ {
        self.by_name.get(name).into_iter().flatten().map(move |&i| &self.files[i])
    }

    /// Every file's import contribution, in walk order (for a whole-repo scan).
    pub fn files(&self) -> &[FileImports] {
        &self.files
    }
}

fn read_text(repo: &str, rel: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}
