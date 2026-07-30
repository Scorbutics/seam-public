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
    /// Memoized `normpath(target) → files that `export * from` it`. Lazy: only the barrel-following paths need
    /// it, and building it costs one resolution pass over every file's star exports.
    star_index: Mutex<Option<Arc<HashMap<String, Vec<String>>>>>,
}

// Per-repo memoization — the index + resolvers are pure functions of the repo's source and immutable within a
// query run, so building them once and sharing turns a repeated-footprint shape (impact/reaches/compare, which
// build hundreds of footprints) from N repo-walks into one. Mirrors `CallsiteIndex::cached`.
static CACHE: Lazy<Mutex<HashMap<String, Arc<Workspace>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

impl Workspace {
    pub fn new(repo: &str) -> Self {
        Self {
            repo: repo.to_string(),
            index: ImportIndex::build(repo),
            resolvers: Mutex::new(HashMap::new()),
            star_index: Mutex::new(None),
        }
    }

    /// The memoized workspace for `repo` (built on first request, shared thereafter). Use this on the query
    /// path; `new` bypasses the cache (tests, or a forced rebuild).
    pub fn cached(repo: &str) -> Arc<Workspace> {
        if let Some(ws) = CACHE.lock().unwrap().get(repo) {
            return ws.clone();
        }
        let t = std::time::Instant::now();
        let ws = Arc::new(Self::new(repo));
        if seam_fs::debug_on("perf") {
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
        // STAR BARRELS (`export * from "…anchor…"`) forward the name UNCHANGED. They are invisible to
        // `scan_direct`, which is name-keyed, so this path followed the named form only — and the two shapes then
        // disagreed in the CLI gate about the very same fixture: `--query contract` listed 6 consuming files while
        // `--query consumers` resolved 5, the missing one sitting behind a star barrel. A reader cannot tell which
        // number to trust, which is the same defect as the usage-site/call-site collision.
        //
        // FOLLOWED, but not itself emitted as a consumer — the module path makes the same distinction and for the
        // same reason: a named re-export is evidence about one symbol, `export *` is evidence about none.
        for barrel in self.star_exporters().get(&normpath(anchor_file)).into_iter().flatten() {
            out.extend(self.scan_rec(barrel, symbol, visited, hop + 1));
        }
        out
    }

    /// `normpath(target module) → the files that `export * from` it`. Built once per workspace, because the
    /// symbol-anchored scan is called per symbol and a per-call repo pass would make a fan-out shape quadratic.
    fn star_exporters(&self) -> Arc<HashMap<String, Vec<String>>> {
        if let Some(m) = self.star_index.lock().unwrap().as_ref() {
            return m.clone();
        }
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for fi in self.index.files() {
            for st in &fi.stars {
                if let Some(t) = self.resolve(&fi.rel, &st.source) {
                    let tnorm = normpath(&t);
                    if tnorm != normpath(&fi.rel) {
                        map.entry(tnorm).or_default().push(fi.rel.clone());
                    }
                }
            }
        }
        // walk order is preserved by construction; dedupe a file that stars the same target twice
        for v in map.values_mut() {
            let mut seen = HashSet::new();
            v.retain(|f| seen.insert(f.clone()));
        }
        let arc = Arc::new(map);
        *self.star_index.lock().unwrap() = Some(arc.clone());
        arc
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
    ///
    /// FOLLOWS BARREL RE-EXPORTS, like the symbol-anchored `scan_consumers` above. It did not, and that was the
    /// one correctness gap the tsc oracle sweep could still see: `lib/utils/missions.ts` exports
    /// `mapTasksToReceivedMissions`, `lib/services/missions.ts` forwards it with
    /// `export { mapTasksToReceivedMissions } from "@/lib/utils/missions"`, and
    /// `app/api/missions/received/route.ts` imports it FROM THE BARREL and calls it twice. Matching only imports
    /// whose source resolves directly to the anchor dropped that file entirely — so the contract claimed 6 call
    /// sites where tsc proved 8, and the same undercount hit the module footprint, `afferent`, and every shape
    /// built on the module graph. The two reverse-import paths disagreed on the same repo; now they don't.
    ///
    /// ONE (member, local) PAIR PER MEMBER — a file importing the same member twice under two names keeps the
    /// first, because the module graph draws one edge per member and a second pair would be a duplicate edge.
    /// A caller that needs every binding (the contract's call-site count does: the call sites spell the LOCAL)
    /// wants `module_consumer_locals` instead.
    ///
    /// BOTH BARREL MECHANISMS are followed: the named form (`export { x } from …`, carried on an `ImportRef` as
    /// `reexport`) and the STAR form (`export * from …`, which names nothing and so needed its own index entry).
    /// The star form is not a curiosity — cal.com has 343 of them, and every package `index.ts` is one.
    pub fn scan_module_consumers(&self, anchor_file: &str, member_names: &HashSet<String>) -> Vec<(String, Vec<(String, String)>)> {
        self.module_consumer_locals(anchor_file, member_names)
            .into_iter()
            .map(|(rel, pairs)| {
                let mut seen: HashSet<String> = HashSet::new();
                (rel, pairs.into_iter().filter(|(m, _)| seen.insert(m.clone())).collect())
            })
            .collect()
    }

    /// The same reverse-import walk, keeping EVERY binding: `(consumer file, [(member, the local name that file
    /// calls it by), …])`.
    ///
    /// The local is the part a name-grained call-site count needs and the deduped view above throws away.
    /// Measured on private-app: `components/admin/utils.tsx` re-exports `computeWeekAnchor` from
    /// `lib/utils/week.ts` as `getWeekStartForPreference`, and `app/dashboard/actions/page.tsx` calls THAT name
    /// four times. Following the barrel put `page.tsx` in the consumer list, but grepping its parse for
    /// `computeWeekAnchor` found nothing — so the contract said 15 call sites where tsc proved 19. The rename is
    /// not an edge case: a barrel exists precisely so callers can spell a name differently.
    pub fn module_consumer_locals(&self, anchor_file: &str, member_names: &HashSet<String>) -> Vec<(String, Vec<(String, String)>)> {
        let anchor_norm = normpath(anchor_file);
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

        // THE FRONTIER, keyed by normalised module path: a module → (a name it exports → the ANCHOR member that
        // name ultimately stands for). Hop 0 is the anchor alone; each later hop is the barrels the previous one
        // found. Keyed by module rather than iterated per module so the whole hop costs ONE pass over the import
        // index: following twenty barrels is two passes, not twenty-one.
        struct Hop {
            name_to_member: HashMap<String, String>,
            /// Only ever set for the anchor — a barrel's own default slot has nothing to do with our members.
            default_member: Option<String>,
        }
        let mut frontier: HashMap<String, Hop> = HashMap::new();
        frontier.insert(
            anchor_norm.clone(),
            Hop { name_to_member: member_names.iter().map(|m| (m.clone(), m.clone())).collect(), default_member },
        );

        // rel → its used members, INSERTION-ORDERED. A map and not a Vec because a file can now be reached at two
        // different hops (it imports one member directly and another through a barrel) and must stay ONE entry —
        // the module graph makes one consumer node per entry, so a duplicate would be a phantom second consumer.
        let mut out: indexmap::IndexMap<String, Vec<(String, String)>> = indexmap::IndexMap::new();
        let mut used_names: HashMap<String, HashSet<String>> = HashMap::new();
        // (barrel file, the name it forwards) — stops a re-export ring from looping inside the hop cap.
        let mut visited: HashSet<String> = HashSet::new();

        for _hop in 0..=REEXPORT_HOP_CAP {
            let mut next: HashMap<String, Hop> = HashMap::new();
            for fi in self.index.files() {
                let fnorm = normpath(&fi.rel);
                // The anchor is never its own consumer — and now that barrels are followed it could become one,
                // via a ring where the anchor imports from a barrel that forwards the anchor's own export back.
                if fnorm == anchor_norm {
                    continue;
                }
                for r in &fi.refs {
                    // _resolve_import: a source-less ref resolves via LSP (no active resolver here) → skip.
                    let Some(source) = &r.source else { continue };
                    let Some(target) = self.resolve(&fi.rel, source) else { continue };
                    let tnorm = normpath(&target);
                    if tnorm == fnorm {
                        continue; // a module importing itself is not its own consumer
                    }
                    let Some(hop) = frontier.get(&tnorm) else { continue };
                    // `default` (a default import / `default as X` re-export) names the module's default SLOT, not
                    // a member — attribute it to the member that FILLS that slot, exactly as the symbol-anchored
                    // path does.
                    let Some(member) = (if r.name == "default" {
                        hop.default_member.clone()
                    } else {
                        hop.name_to_member.get(&r.name).cloned()
                    }) else {
                        continue;
                    };
                    // A BARREL HOP. This file forwards the member under `r.local` instead of (or as well as)
                    // using it, so whoever imports `r.local` from HERE is a consumer of the anchor's member.
                    if r.reexport && visited.insert(format!("{fnorm}::{}", r.local)) {
                        next.entry(fnorm.clone())
                            .or_insert_with(|| Hop { name_to_member: HashMap::new(), default_member: None })
                            .name_to_member
                            .insert(r.local.clone(), member.clone());
                    }
                    // Deduped by (member, LOCAL), so the same import written twice collapses but two distinct
                    // bindings of one member both survive. The JS `Object.prototype` guard is the `in`-on-`{}`
                    // quirk of the original `used[member] = local`, kept for parity.
                    let seen = used_names.entry(fnorm.clone()).or_default();
                    let key = format!("{member}::{}", r.local);
                    if !seen.contains(&key) && !seam_lang::ast::is_js_object_proto_prop(&member) {
                        seen.insert(key);
                        out.entry(fi.rel.clone()).or_default().push((member, r.local.clone()));
                    }
                }
                // A STAR BARREL (`export * from "…"`) forwards every name UNCHANGED, so the whole name→member map
                // passes through untouched.
                //
                // IT IS A HOP AND NOT A CONSUMER — unlike the named form above, which is. The distinction is not
                // cosmetic: a NAMED re-export is evidence about ONE symbol (somebody wrote that name on purpose),
                // while `export *` is evidence about nothing, because it forwards whatever happens to be there.
                // Counting it as a consumer was tried and a falsification test killed it: it made
                // `unusedByAnyone` — an export no file anywhere imports — look consumed, and on a repo like
                // cal.com (343 star barrels, one per package `index.ts`) the whole "unused exports = dead public
                // API" signal would read as empty everywhere. Members are visited in sorted order so the frontier
                // does not inherit hash order.
                for st in &fi.stars {
                    let Some(target) = self.resolve(&fi.rel, &st.source) else { continue };
                    let tnorm = normpath(&target);
                    if tnorm == fnorm {
                        continue;
                    }
                    let Some(hop) = frontier.get(&tnorm) else { continue };
                    let mut forwarded: Vec<(&String, &String)> = hop.name_to_member.iter().collect();
                    forwarded.sort();
                    for (name, member) in forwarded {
                        if !visited.insert(format!("{fnorm}::{name}")) {
                            continue;
                        }
                        next.entry(fnorm.clone())
                            .or_insert_with(|| Hop { name_to_member: HashMap::new(), default_member: None })
                            .name_to_member
                            .insert(name.clone(), member.clone());
                    }
                }
                // A plain `import X from "…anchor…"` carries no ref at all — it lands in the entry's `defs`.
                for d in &fi.defs {
                    let Some(target) = self.resolve(&fi.rel, &d.source) else { continue };
                    let tnorm = normpath(&target);
                    if tnorm == fnorm {
                        continue;
                    }
                    let Some(dm) = frontier.get(&tnorm).and_then(|h| h.default_member.clone()) else { continue };
                    let seen = used_names.entry(fnorm.clone()).or_default();
                    let key = format!("{dm}::{}", d.local);
                    if !seen.contains(&key) && !seam_lang::ast::is_js_object_proto_prop(&dm) {
                        seen.insert(key);
                        out.entry(fi.rel.clone()).or_default().push((dm, d.local.clone()));
                    }
                }
            }
            if next.is_empty() {
                break;
            }
            frontier = next;
        }
        out.into_iter().collect()
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
