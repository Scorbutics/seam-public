//! SPAN + COLUMN-GRAIN primitives for the `writers` / `coupling` shapes. Port of `symbol_span` and
//! `accessColumns` (ts/src/codebase/coupling/bridge.ts).
//!
//! The coupling floor keys the TABLE (`booking`). These refine an answer one grain finer:
//!   - `symbol_span` scopes an anchor's keys to ONE symbol instead of the whole file.
//!   - `access_columns` reads the COLUMNS an ORM access touches — a write's `data` keys, a read's `where` keys
//!     — so "who writes the state this reader FILTERS on" is answerable without a second query.
//! Empty ⇒ OPAQUE, never "no columns": the caller must KEEP an unparseable writer (flagged unverified) rather
//! than drop a real write. Structural (AST keys), never a name guess.

use seam_lang::{ast, node_kinds as nk, provider_for, Ctx, Node};
use std::collections::HashSet;

/// The TIGHTEST span of the funclike/class named `symbol` in `file`, or `None` when the file cannot be parsed
/// or holds no such declaration (⇒ the caller scopes to the whole file). Port of `symbol_span`.
pub fn symbol_span(repo: &str, file: &str, symbol: &str) -> Option<(usize, usize)> {
    let grammar = seam_lang::grammar_for(file)?;
    let text = std::fs::read(format!("{repo}/{file}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())?;
    let ctx = Ctx::parse(&text, &grammar)?;
    let mut best: Option<(usize, usize)> = None;
    for n in ctx.collect(ctx.root(), |k| nk::is_funclike(k) || nk::is_class_kind(k)) {
        if ast::name_of(&ctx, n).as_deref() != Some(symbol) {
            continue;
        }
        let (s, e) = ctx.span(n);
        // tightest match if the name recurs
        if best.is_none_or(|(bs, be)| (e - s) < (be - bs)) {
            best = Some((s, e));
        }
    }
    best
}

/// The columns an ORM access touches at `line`: `{writes, reads}`. Both empty = opaque.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccessColumns {
    pub writes: Vec<String>,
    pub reads: Vec<String>,
}

const WHERE_LOGIC: &[&str] = &["AND", "OR", "NOT"];

fn unquote(s: &str) -> String {
    s.trim_start_matches(['"', '\'', '`']).trim_end_matches(['"', '\'', '`']).to_string()
}

/// An object literal's KEYS — descending one level through the `AND`/`OR` (array of objects) and `NOT` (object)
/// logical wrappers, which name a combinator, not a column. Deduped, first-seen order. Port of `_objColumns`.
fn obj_columns(ctx: &Ctx, obj: Option<Node>) -> Vec<String> {
    let Some(obj) = obj else { return Vec::new() };
    if obj.kind() != "object" {
        return Vec::new();
    }
    let mut cols: Vec<String> = Vec::new();
    for p in ctx.children(obj) {
        if p.kind() != "pair" {
            continue;
        }
        let key = p.child_by_field_name("key").map(|k| unquote(ctx.text(k))).unwrap_or_default();
        if key.is_empty() {
            continue;
        }
        if WHERE_LOGIC.contains(&key.as_str()) {
            let val = p.child_by_field_name("value");
            let subs: Vec<Node> = match val {
                Some(v) if v.kind() == "array" => ctx.children(v).into_iter().filter(|c| c.kind() == "object").collect(),
                Some(v) if v.kind() == "object" => vec![v],
                _ => Vec::new(),
            };
            for so in subs {
                cols.extend(obj_columns(ctx, Some(so)));
            }
        } else {
            cols.push(key);
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    cols.into_iter().filter(|c| seen.insert(c.clone())).collect()
}

/// The value of object property `name`, or `None`. Port of `_prop`.
fn prop<'t>(ctx: &Ctx, obj: Node<'t>, name: &str) -> Option<Node<'t>> {
    for p in ctx.children(obj) {
        if p.kind() != "pair" {
            continue;
        }
        if p.child_by_field_name("key").is_some_and(|k| unquote(ctx.text(k)) == name) {
            return p.child_by_field_name("value");
        }
    }
    None
}

/// Columns touched by the ORM access at `line` in an ALREADY-PARSED file. The INNERMOST `call_expression`
/// containing the line whose first argument is a config object carrying `data`/`where` is the ORM call —
/// innermost, because a `.update({...})` nested in an outer `await tx.$transaction([...])` must resolve to its
/// own config, not the wrapper's. Port of `accessColumns`' parse-half.
pub fn access_columns_in(ctx: &Ctx, line: usize) -> AccessColumns {
    let mut best: Option<AccessColumns> = None;
    let mut best_size = usize::MAX;
    for call in ctx.collect(ctx.root(), |k| k == "call_expression") {
        let (s, e) = ctx.span(call);
        if line < s || line > e || (e - s) >= best_size {
            continue;
        }
        let Some(args) = call.child_by_field_name("arguments") else { continue };
        let Some(cfg) = args.named_child(0) else { continue };
        if cfg.kind() != "object" {
            continue;
        }
        let writes = obj_columns(ctx, prop(ctx, cfg, "data"));
        let reads = obj_columns(ctx, prop(ctx, cfg, "where"));
        if !writes.is_empty() || !reads.is_empty() {
            best_size = e - s;
            best = Some(AccessColumns { writes, reads });
        }
    }
    best.unwrap_or_default()
}

/// `access_columns_in` for a file on disk. The caller passes a per-run parse cache — the column pass revisits
/// the same files many times (one access per line), and re-parsing each is the measured cost.
pub fn access_columns(repo: &str, file: &str, line: usize, cache: &mut std::collections::HashMap<String, Option<Ctx>>) -> AccessColumns {
    if provider_for(file).is_none() {
        return AccessColumns::default();
    }
    if !cache.contains_key(file) {
        let parsed = seam_lang::grammar_for(file).and_then(|g| {
            std::fs::read(format!("{repo}/{file}")).ok().and_then(|b| Ctx::parse(&String::from_utf8_lossy(&b), &g))
        });
        cache.insert(file.to_string(), parsed);
    }
    match cache.get(file).and_then(|c| c.as_ref()) {
        Some(ctx) => access_columns_in(ctx, line),
        None => AccessColumns::default(),
    }
}
