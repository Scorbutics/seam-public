//! The COMPLEMENT UNIT at a line — the enclosing function/class/method a complement access sits in, so a
//! materialised complement node carries a real symbol + span (not just a file). Smallest funclike/class span
//! containing the line; falls back to the file module. Port of `complement_unit` (bridge.ts).

use seam_lang::ast::name_of;
use seam_lang::node_kinds::{is_class_kind, is_funclike, is_method_kind};
use seam_lang::{grammar_for, Ctx};

/// The funclike/class candidate units in a file: (name, kind, start, end), in `ctx.collect` order. Cached per
/// file content-epoch — the tree-sitter parse (the coupling fan calls this per reached complement) was ~7s of
/// cold; a warm/near run skips it entirely. The order matches the uncached scan so the first-min-wins tie-break
/// in `complement_unit` stays byte-identical.
fn complement_units(repo: &str, file: &str, grammar: &str) -> Vec<(String, String, usize, usize)> {
    let epoch = seam_cache::epoch_of(repo);
    seam_cache::cached(repo, "complement-units-v1", file, "cu", &epoch, || {
        let Ok(bytes) = std::fs::read(format!("{repo}/{file}")) else { return Vec::new() };
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let Some(ctx) = Ctx::parse(&content, grammar) else { return Vec::new() };
        let mut out: Vec<(String, String, usize, usize)> = Vec::new();
        for n in ctx.collect(ctx.root(), |k| is_funclike(k) || is_class_kind(k)) {
            let (s, e) = ctx.span(n);
            let Some(nm) = name_of(&ctx, n) else { continue };
            let kind = if is_class_kind(n.kind()) {
                "class"
            } else if is_method_kind(n.kind()) {
                "method"
            } else {
                "function"
            };
            out.push((nm, kind.to_string(), s, e));
        }
        out
    })
}

/// The enclosing unit of `line` (0-based) in `repo/file` — smallest funclike/class span containing it, else the
/// file module. Port of `complement_unit`; the parse is cached per file via `complement_units`.
pub fn complement_unit(repo: &str, file: &str, line: usize) -> (String, String, usize, usize) {
    let fallback = (seam_fs::stem(file), "module".to_string(), line, line);
    let Some(grammar) = grammar_for(file) else { return fallback };
    let units = complement_units(repo, file, grammar);
    let mut best: Option<&(String, String, usize, usize)> = None;
    for u in &units {
        if u.2 > line || line > u.3 {
            continue;
        }
        if best.map_or(true, |b| (u.3 - u.2) < (b.3 - b.2)) {
            best = Some(u);
        }
    }
    best.cloned().unwrap_or(fallback)
}
