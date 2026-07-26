//! Resolve a NAME used in a file to the file that DEFINES it, following the deterministic resolution graph:
//! same-file def → a NAMED import / re-export barrel hop → a DEFAULT import (→ the module's default export).
//! Port of `scan/def_resolve.ts`, and — exactly as on the TS side — the ONE hop ladder shared by the DOWN
//! pass (which resolves a TYPE name) and the UP pass (which resolves a FUNCTION name for the factory hop).
//! Depth-capped against import cycles.

use crate::util::read;
use once_cell::sync::Lazy as L;
use regex::Regex as Rx;
use seam_lang::{ast, provider_for, Ctx};
use seam_resolve::Workspace;

/// The unit KINDS `named_units` emits that a caller counts as "the definition" it is after.
/// (`named_units` labels every class-like node — incl. interfaces/enums — "class".)
pub const DEF_TYPE_KINDS: &[&str] = &["class", "interface"];
pub const DEF_FUNC_KINDS: &[&str] = &["function", "method"];

static EXPORT_DEFAULT_DEF: L<Rx> =
    L::new(|| Rx::new(r"export\s+default\s+(?:async\s+)?(?:function|class)\s+[A-Za-z_$][\w$]*").unwrap());
static EXPORT_DEFAULT_NAME: L<Rx> = L::new(|| Rx::new(r"export\s+default\s+([A-Za-z_$][\w$]*)\s*;").unwrap());
static EXPORT_AS_DEFAULT: L<Rx> =
    L::new(|| Rx::new(r"export\s*\{[^}]*\b([A-Za-z_$][\w$]*)\s+as\s+default\b").unwrap());

fn resolve_import_file(repo: &str, importing: &str, source: Option<&str>) -> Option<String> {
    source.and_then(|s| Workspace::cached(repo).resolve(importing, s))
}

/// The file DEFINING `name` as used in `from_file`, or None. `kinds` says which unit kinds count.
pub fn resolve_def_file(repo: &str, from_file: &str, name: &str, kinds: &[&str], depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    let (text, grammar) = read(repo, from_file)?;
    let ctx = Ctx::parse(&text, &grammar)?;
    if ast::named_units(&ctx).iter().any(|u| u.name == name && kinds.contains(&u.kind.as_str())) {
        return Some(from_file.to_string());
    }
    let provider = provider_for(from_file)?;
    for r in provider.imports(&text) {
        if r.local == name || r.name == name {
            if let Some(t) = resolve_import_file(repo, from_file, r.source.as_deref()) {
                if let Some(d) = resolve_def_file(repo, &t, &r.name, kinds, depth + 1) {
                    return Some(d);
                }
            }
        }
    }
    for di in provider.default_imports(&text) {
        if di.local == name {
            if let Some(t) = resolve_import_file(repo, from_file, Some(&di.source)) {
                if let Some(d) = resolve_default_export_def(repo, &t, kinds, depth + 1) {
                    return Some(d);
                }
            }
        }
    }
    None
}

/// Is the bare NAME `name`, as used in `file`, PROVABLY bound to a symbol that lives somewhere ELSE?
/// An import declaration creates the file's module-scope binding for that name, so a bare `name(...)` there is
/// the IMPORT — not a same-named METHOD of a class declared in the same file (a method is not a module binding,
/// so the two can coexist and mean different things). Same hop ladder as `resolve_def_file`, so there is ONE
/// import-resolution mechanism (and languages with no import parser simply return false).
/// PROOF-ONLY, never a guess: returns false (⇒ the caller keeps its existing behaviour) when the module does not
/// resolve, and when the ladder resolves the name back to `file` itself (a self re-export barrel).
/// Port of `importBindsElsewhere`.
pub fn import_binds_elsewhere(repo: &str, file: &str, text: &str, name: &str) -> bool {
    let Some(provider) = provider_for(file) else { return false };
    let mut targets: Vec<(String, String)> = Vec::new(); // (target file, the name to look for THERE)
    for r in provider.imports(text) {
        if r.local != name || r.reexport {
            continue; // `export { X } from '…'` is a barrel hop, not a local binding
        }
        if let Some(t) = resolve_import_file(repo, file, r.source.as_deref()) {
            targets.push((t, r.name.clone()));
        }
    }
    for di in provider.default_imports(text) {
        if di.local != name {
            continue;
        }
        if let Some(t) = resolve_import_file(repo, file, Some(&di.source)) {
            targets.push((t, di.local.clone()));
        }
    }
    let file_norm = seam_fs::normpath(file);
    for (tf, tn) in targets {
        if seam_fs::normpath(&tf) == file_norm {
            continue; // the import resolves to THIS file — not "elsewhere"
        }
        match resolve_def_file(repo, &tf, &tn, DEF_FUNC_KINDS, 0) {
            Some(d) if seam_fs::normpath(&d) == file_norm => continue, // a re-export ring back to us — unprovable, keep it
            _ => return true,
        }
    }
    false
}

/// The file DEFINING a module's default export. Port of `_resolveDefaultExportDef`.
pub fn resolve_default_export_def(repo: &str, module_file: &str, kinds: &[&str], depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    let (text, _) = read(repo, module_file)?;
    if EXPORT_DEFAULT_DEF.is_match(&text) {
        return Some(module_file.to_string());
    }
    let m = EXPORT_DEFAULT_NAME.captures(&text).or_else(|| EXPORT_AS_DEFAULT.captures(&text))?;
    resolve_def_file(repo, module_file, &m[1], kinds, depth + 1)
}
