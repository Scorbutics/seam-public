//! Language-AGNOSTIC cross-file resolution. Dispatches only through the language-layer traits — it never
//! names a language. Owns the per-repo state (the import index + the per-language module resolvers).

pub mod callsite_index;
pub mod consumers;
pub mod import_index;
pub mod file_ref;
pub mod interface_index;

pub use callsite_index::CallsiteIndex;
pub use file_ref::{file_referencers, is_path_literal, reset_file_ref_index, resolve_file_ref};
pub use interface_index::{Impl, InterfaceIndex};
pub use consumers::{Consumer, Status};

use import_index::ImportIndex;
use once_cell::sync::Lazy;
use seam_fs::{normpath, stem};
use seam_lang::{provider_for, ModuleResolver};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

const REEXPORT_HOP_CAP: u32 = 5;

/// A repo under analysis: an immutable import index (built once) plus per-language resolvers, built lazily so
/// each language's repo-wide index is computed at most once. Replaces TS's module-global mutable caches.
/// Shareable (Send+Sync) so it can be memoized per repo — see `cached`.
pub struct Workspace {
    repo: String,
    index: ImportIndex,
    resolvers: Mutex<HashMap<&'static str, Box<dyn ModuleResolver>>>,
}

// Per-repo memoization — the index + resolvers are pure functions of the repo's source and immutable within a
// query run, so building them once and sharing turns a repeated-footprint shape (impact/reaches/compare, which
// build hundreds of footprints) from N repo-walks into one. Mirrors `CallsiteIndex::cached`.
static CACHE: Lazy<Mutex<HashMap<String, Arc<Workspace>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

impl Workspace {
    pub fn new(repo: &str) -> Self {
        Self { repo: repo.to_string(), index: ImportIndex::build(repo), resolvers: Mutex::new(HashMap::new()) }
    }

    /// The memoized workspace for `repo` (built on first request, shared thereafter). Use this on the query
    /// path; `new` bypasses the cache (tests, or a forced rebuild).
    pub fn cached(repo: &str) -> Arc<Workspace> {
        if let Some(ws) = CACHE.lock().unwrap().get(repo) {
            return ws.clone();
        }
        let t = std::time::Instant::now();
        let ws = Arc::new(Self::new(repo));
        if std::env::var("SEAM_PERF").is_ok() {
            eprintln!("[perf] workspace(import_index) build {:.2}s", t.elapsed().as_secs_f64());
        }
        CACHE.lock().unwrap().insert(repo.to_string(), ws.clone());
        ws
    }

    /// Drop the memoized workspace for `repo` (or all repos when `None`).
    pub fn reset(repo: Option<&str>) {
        let mut c = CACHE.lock().unwrap();
        match repo {
            Some(r) => {
                c.remove(r);
            }
            None => c.clear(),
        }
    }

    /// Resolve a module `source` imported from `importing_file`, dispatching to that file's language resolver.
    pub fn resolve(&self, importing_file: &str, source: &str) -> Option<String> {
        let provider = provider_for(importing_file)?;
        self.resolvers
            .lock()
            .unwrap()
            .entry(provider.name())
            .or_insert_with(|| provider.resolver(&self.repo))
            .resolve(importing_file, source)
    }

    /// The files that consume `symbol` exported from `anchor_file` — a reverse-import query. Follows barrel
    /// re-exports transitively (TS/JS), dedupes by (file, local). Port of `scan_consumers`.
    pub fn scan_consumers(&self, anchor_file: &str, symbol: &str) -> Vec<Consumer> {
        let out = self.scan_rec(anchor_file, symbol, &mut HashSet::new(), 0);
        let mut seen = HashSet::new();
        out.into_iter().filter(|c| seen.insert(format!("{}::{}", c.file, c.local))).collect()
    }

    /// The repo-wide REVERSE-IMPORT map: `normpath(target file) → the files that import it`. Every file's
    /// import sources (named/namespace/default) are resolved to their target; a file importing itself is
    /// skipped. The ubiquity prior derives cross-module fan-in from this. Port of `fileImporters`.
    ///
    /// INSERTION-ORDERED (first-seen target first), because the TypeScript's `Map` is and a consumer that
    /// RANKS these — `warm`'s hub selection — breaks ties by that order before capping. A HashMap here would
    /// leak Rust's hash order into which hubs get warmed.
    pub fn file_importers(&self) -> indexmap::IndexMap<String, HashSet<String>> {
        let mut out: indexmap::IndexMap<String, HashSet<String>> = indexmap::IndexMap::new();
        for fi in self.index.files() {
            // INSERTION-ORDERED, like the TypeScript's `Set`. A HashSet here decides which of a file's
            // targets is inserted into `out` FIRST, which is the tie-break `warm`'s hub ranking cuts on —
            // measured, it reordered the fan-in-7 plateau of this repo's own tree.
            let mut sources: indexmap::IndexSet<String> = indexmap::IndexSet::new();
            for r in &fi.refs {
                if let Some(s) = &r.source {
                    sources.insert(s.clone());
                }
            }
            for n in &fi.ns {
                sources.insert(n.source.clone());
            }
            for d in &fi.defs {
                sources.insert(d.source.clone());
            }
            for src in &sources {
                if let Some(t) = self.resolve(&fi.rel, src) {
                    if normpath(&t) != normpath(&fi.rel) {
                        out.entry(normpath(&t)).or_default().insert(fi.rel.clone());
                    }
                }
            }
        }
        out
    }

    fn scan_rec(&self, anchor_file: &str, symbol: &str, visited: &mut HashSet<String>, hop: u32) -> Vec<Consumer> {
        if hop > REEXPORT_HOP_CAP || !visited.insert(format!("{}::{}", normpath(anchor_file), symbol)) {
            return Vec::new();
        }
        let mut out = Vec::new();
        for c in self.scan_direct(anchor_file, symbol) {
            let recurse = c.reexport && c.status == Status::ResolvedFull; // a barrel re-export → follow it
            let (file, local) = (c.file.clone(), c.local.clone());
            out.push(c);
            if recurse {
                out.extend(self.scan_rec(&file, &local, visited, hop + 1));
            }
        }
        out
    }

    // The direct consumers of `symbol` at `anchor_file`: NAMED (a binding called `symbol`), NAMESPACE-member
    // (`X.symbol` where X binds the anchor module), and DEFAULT-export (a default import of the anchor, when
    // `symbol` IS its default export). The ns/default paths are TS/JS — dispatched via the provider, so they
    // contribute nothing for a Java anchor (no ns/default entries).
    fn scan_direct(&self, anchor_file: &str, symbol: &str) -> Vec<Consumer> {
        let anchor_norm = normpath(anchor_file);
        let anchor_base = stem(anchor_file);
        let anchor_abs = normpath(&format!("{}/{}", self.repo, anchor_file));
        let mut out = Vec::new();
        // NAMED
        for entry in self.index.by_name(symbol) {
            if entry.norm == anchor_abs {
                continue; // the anchor's own file
            }
            let Some(r) = entry.refs.iter().find(|r| r.name == symbol) else {
                continue; // only the first binding named `symbol` per file is considered
            };
            let source = r.source.as_deref().unwrap_or("");
            match self.resolve(&entry.rel, source) {
                Some(target) if normpath(&target) == anchor_norm => out.push(Consumer {
                    file: entry.rel.clone(),
                    local: r.local.clone(),
                    source: r.source.clone().unwrap_or_default(),
                    status: Status::ResolvedFull,
                    reexport: r.reexport,
                    line: Some(r.line as usize),
                }),
                Some(_) => {} // resolved, but to a different file → not a consumer of this anchor
                None => {
                    if let Some(src) = &r.source {
                        let base = src.trim_end_matches('/').rsplit('/').next().unwrap_or(src);
                        if base == anchor_base {
                            out.push(Consumer {
                                file: entry.rel.clone(),
                                local: r.local.clone(),
                                source: src.clone(),
                                status: Status::Suggested,
                                reexport: r.reexport,
                                line: Some(r.line as usize),
                            });
                        }
                    }
                }
            }
        }
        // NAMESPACE-member: `const X = import("…anchor…")` / `import * as X` then `X.symbol`.
        for entry in self.index.ns_entries() {
            if entry.norm == anchor_abs {
                continue;
            }
            let Some(text) = read_text(&self.repo, &entry.rel) else { continue };
            let provider = provider_for(&entry.rel);
            for n in &entry.ns {
                match self.resolve(&entry.rel, &n.source) {
                    Some(t) if normpath(&t) == anchor_norm => {}
                    _ => continue,
                }
                if let Some(status) = provider.and_then(|p| p.member_use(&text, &n.local, symbol)) {
                    out.push(Consumer { file: entry.rel.clone(), local: symbol.to_string(), source: n.source.clone(), status: status_of(status), reexport: false, line: Some(n.line as usize) });
                    break;
                }
            }
        }
        // DEFAULT-export: only when `symbol` is the anchor's default export. A `default as Name` re-export
        // barrel (followed transitively) and a direct `import Name from "anchor"`.
        if self.is_default_export(anchor_file, symbol) {
            for entry in self.index.default_entries() {
                if entry.norm == anchor_abs {
                    continue;
                }
                for r in entry.refs.iter().filter(|r| r.name == "default" && r.reexport) {
                    let source = r.source.as_deref().unwrap_or("");
                    if self.resolve(&entry.rel, source).is_some_and(|t| normpath(&t) == anchor_norm) {
                        out.push(Consumer { file: entry.rel.clone(), local: r.local.clone(), source: r.source.clone().unwrap_or_default(), status: Status::ResolvedFull, reexport: true, line: Some(r.line as usize) });
                        break;
                    }
                }
                for d in &entry.defs {
                    if self.resolve(&entry.rel, &d.source).is_some_and(|t| normpath(&t) == anchor_norm) {
                        out.push(Consumer { file: entry.rel.clone(), local: d.local.clone(), source: d.source.clone(), status: Status::ResolvedFull, reexport: false, line: Some(d.line as usize) });
                        break;
                    }
                }
            }
        }
        out
    }

    /// Is `symbol` the default export of `anchor_file`? Dispatched to the file's provider (TS/JS only).
    fn is_default_export(&self, anchor_file: &str, symbol: &str) -> bool {
        let Some(provider) = provider_for(anchor_file) else { return false };
        let Some(text) = read_text(&self.repo, anchor_file) else { return false };
        provider.is_default_export(&text, symbol)
    }

    /// The local declaration that provably FILLS `anchor_file`'s DEFAULT-export slot — `export default sym`,
    /// `export default function sym`, `export { sym as default }`, or the impl behind a wrapper call. `None`
    /// when there is no default export or the slot is opaque. Port of `defaultExportSlot(...).local`; the
    /// grounded gate every default-import path shares (`is_default_export` is this === symbol).
    pub fn default_export_slot_local(&self, anchor_file: &str) -> Option<String> {
        let provider = provider_for(anchor_file)?;
        let text = read_text(&self.repo, anchor_file)?;
        provider.default_export(&text).local
    }

    /// The raw DEFAULT-export slot expression of `anchor_file` when it resolves to NO declaration of that file
    /// — an anonymous `export default () => …`, an unprovable wrapper. `None` when there is no default export
    /// or the slot is proven (then it is a normal member and its importers resolve above). Port of
    /// `defaultExportSlot`'s opaque case.
    pub fn opaque_default_slot(&self, anchor_file: &str) -> Option<String> {
        let provider = provider_for(anchor_file)?;
        let text = read_text(&self.repo, anchor_file)?;
        let slot = provider.default_export(&text);
        match (slot.local, slot.expr) {
            (None, Some(expr)) => Some(expr),
            _ => None,
        }
    }

    /// Files that DEFAULT-import `anchor_file`. Used only to NAME the consumers an opaque default slot hides.
    /// Port of `default_importers`.
    pub fn default_importers(&self, anchor_file: &str) -> Vec<String> {
        let anchor_norm = normpath(anchor_file);
        let anchor_abs = normpath(&format!("{}/{}", self.repo, anchor_file));
        let mut out = Vec::new();
        for entry in self.index.default_entries() {
            if entry.norm == anchor_abs {
                continue;
            }
            let mut hit = entry.defs.iter().any(|d| self.resolve(&entry.rel, &d.source).is_some_and(|t| normpath(&t) == anchor_norm));
            if !hit {
                hit = entry.refs.iter().filter(|r| r.name == "default").any(|r| {
                    self.resolve(&entry.rel, r.source.as_deref().unwrap_or("")).is_some_and(|t| normpath(&t) == anchor_norm)
                });
            }
            if hit {
                out.push(entry.rel.clone());
            }
        }
        out.sort();
        out
    }

    /// Files consuming ANY of `member_names` exported from `anchor_file` → `(rel, [(member, local), …])` in
    /// walk order, the `used` map in first-seen order. The whole-module reverse-import scan behind the module
    /// footprint. Port of `scan_module_consumers`.
    pub fn scan_module_consumers(&self, anchor_file: &str, member_names: &HashSet<String>) -> Vec<(String, Vec<(String, String)>)> {
        let anchor_norm = normpath(anchor_file);
        let anchor_abs = normpath(&format!("{}/{}", self.repo, anchor_file));
        // DEFAULT-EXPORT PARITY. `export default prisma` puts a DECLARED member in the module's default slot, and
        // a consumer then writes `import prisma from "@calcom/prisma"` — an import that carries NO member name
        // (its ref name is `default`, or it lands in the entry's `defs`). The named loop below tests
        // `member_names.contains(&r.name)`, so EVERY default-import consumer was dropped: on cal.com that
        // silently lost the 439 files that default-import `prisma`, making the module contract report 379
        // consumers for an export used by 818 files (and the same undercount in fan-in, the union of these
        // files). The SYMBOL-anchored path (`scan_direct`) already resolves them via the default SLOT — so this
        // reuses that SAME grounded gate to map the slot back to the member that fills it. No name matching: a
        // default import counts only when the anchor really declares that member as its default, and only when
        // its module source resolves to the anchor. Port of 7184ecb + fd61636's slot.
        let default_member = self
            .default_export_slot_local(anchor_file)
            .filter(|l| member_names.contains(l));
        let mut out = Vec::new();
        for fi in self.index.files() {
            if fi.norm == anchor_abs {
                continue;
            }
            let mut used_names: HashSet<String> = HashSet::new();
            let mut used: Vec<(String, String)> = Vec::new();
            for r in &fi.refs {
                // `default` (a default import / `default as X` re-export) names the module's default SLOT, not a
                // member — attribute it to the member that FILLS that slot, exactly as the symbol-anchored path does.
                let Some(member) = (if r.name == "default" {
                    default_member.clone()
                } else if member_names.contains(&r.name) {
                    Some(r.name.clone())
                } else {
                    None
                }) else {
                    continue;
                };
                // _resolve_import: a source-less ref resolves via LSP (no active resolver here) → skip.
                let Some(source) = &r.source else { continue };
                let Some(target) = self.resolve(&fi.rel, source) else { continue };
                if normpath(&target) != anchor_norm {
                    continue;
                }
                // `used[member] = local` guarded by `!(member in used)` — skip an already-seen name OR a JS
                // Object.prototype property name (the `in`-on-`{}` quirk).
                if !used_names.contains(&member) && !seam_lang::ast::is_js_object_proto_prop(&member) {
                    used_names.insert(member.clone());
                    used.push((member, r.local.clone()));
                }
            }
            // A plain `import X from "…anchor…"` carries no ref at all — it lands in the entry's `defs`.
            if let Some(dm) = &default_member {
                if !used_names.contains(dm) && !seam_lang::ast::is_js_object_proto_prop(dm) {
                    for d in &fi.defs {
                        if self.resolve(&fi.rel, &d.source).is_some_and(|t| normpath(&t) == anchor_norm) {
                            used.push((dm.clone(), d.local.clone()));
                            break;
                        }
                    }
                }
            }
            if !used.is_empty() {
                out.push((fi.rel.clone(), used));
            }
        }
        out
    }
}

fn read_text(repo: &str, rel: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Map a provenance string (from `member_use`) to a `Status`.
fn status_of(s: &str) -> Status {
    match s {
        "RESOLVED_PARTIAL" => Status::ResolvedPartial,
        _ => Status::ResolvedFull,
    }
}

/// Resolve a batch of `(importing_file, source)` queries against one workspace.
pub fn resolve_batch(repo: &str, queries: &[(String, String)]) -> Vec<Option<String>> {
    let ws = Workspace::new(repo);
    queries.iter().map(|(f, s)| ws.resolve(f, s)).collect()
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    // Workspace (the import index) is per-repo RESIDENT; a warm hit MUST return the same instance and reset()
    // MUST drop it, else an edit-loop resolves imports against a stale index. Hermetic tmp repo.
    #[test]
    fn workspace_memoize_and_invalidate() {
        let dir = std::env::temp_dir().join(format!("seam-ws-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_str().unwrap();
        std::fs::write(dir.join("a.ts"), "export const x = 1;\n").unwrap();

        Workspace::reset(Some(repo));
        let a = Workspace::cached(repo);
        let b = Workspace::cached(repo);
        assert!(Arc::ptr_eq(&a, &b), "warm hit returns the SAME cached Workspace");
        Workspace::reset(Some(repo));
        let c = Workspace::cached(repo);
        assert!(!Arc::ptr_eq(&a, &c), "reset() drops the cache so the next call rebuilds the index");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
