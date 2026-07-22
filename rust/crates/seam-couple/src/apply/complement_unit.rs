//! The COMPLEMENT UNIT at a line — the enclosing function/class/method a complement access sits in, so a
//! materialised complement node carries a real symbol + span (not just a file). Smallest funclike/class span
//! containing the line; falls back to the file module. Port of `complement_unit` (bridge.ts).

use seam_lang::ast::name_of;
use seam_lang::node_kinds::{is_class_kind, is_funclike, is_method_kind};
use seam_lang::{grammar_for, Ctx};

/// The enclosing unit of `line` (0-based) in `repo/file`. Port of `complement_unit`.
pub fn complement_unit(repo: &str, file: &str, line: usize) -> (String, String, usize, usize) {
    let fallback = (seam_fs::stem(file), "module".to_string(), line, line);
    let Some(grammar) = grammar_for(file) else { return fallback };
    let Ok(bytes) = std::fs::read(format!("{repo}/{file}")) else { return fallback };
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let Some(ctx) = Ctx::parse(&content, grammar) else { return fallback };

    let mut best: Option<(String, String, usize, usize)> = None;
    for n in ctx.collect(ctx.root(), |k| is_funclike(k) || is_class_kind(k)) {
        let (s, e) = ctx.span(n);
        if s > line || line > e {
            continue;
        }
        let Some(nm) = name_of(&ctx, n) else { continue };
        if best.as_ref().map_or(true, |b| (e - s) < (b.3 - b.2)) {
            let kind = if is_class_kind(n.kind()) {
                "class"
            } else if is_method_kind(n.kind()) {
                "method"
            } else {
                "function"
            };
            best = Some((nm, kind.to_string(), s, e));
        }
    }
    best.unwrap_or(fallback)
}
