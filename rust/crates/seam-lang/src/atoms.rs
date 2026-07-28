//! ATOMS — the tree-sitter substrate for INTRA-anchor decomposition. Everything else in the engine cuts
//! between units; this cuts *inside* one. A god-object method is a wall of code with no seams the call graph
//! can see, and the only structure left to read is which of its inner functions touch the same names.
//!
//! Port of `atoms.ts`'s extraction half. The node-KIND vocabulary it also carried lives in `node_kinds`
//! already, so only the extractors move here.

use crate::node_kinds::{is_body, is_funclike};
use crate::treesitter::Ctx;
use std::collections::BTreeSet;
use tree_sitter::Node;

/// One inner function of the anchor: its line span and every identifier it mentions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Atom {
    pub start: usize,
    pub end: usize,
    /// SORTED and deduped — the caller intersects these across atoms, and a set with a stable order keeps the
    /// clustering deterministic. (`BTreeSet`, not `HashSet`, for exactly that reason.)
    pub names: BTreeSet<String>,
}

/// The function enclosing `start_line`. Chosen by NEAREST START, tie-broken toward the LARGER span, and only
/// accepted within 3 lines — an anchor's recorded start can sit a line or two off the `function` keyword
/// (a decorator, an `export` prefix, a leading comment absorbed into the node), but a match further away than
/// that is a different function and returning it would decompose the wrong body. Port of `_anchor_func`.
fn anchor_func<'a>(ctx: &'a Ctx, start_line: usize) -> Option<Node<'a>> {
    let funcs = ctx.collect(ctx.root(), is_funclike);
    let key = |n: &Node| -> (usize, isize) {
        let (s, e) = span(ctx, *n);
        (s.abs_diff(start_line), -((e - s) as isize))
    };
    let best = funcs.into_iter().reduce(|a, b| if key(&b) < key(&a) { b } else { a })?;
    (span(ctx, best).0.abs_diff(start_line) <= 3).then_some(best)
}

/// The function's body block, or the function node itself when no body child is found (an expression-bodied
/// arrow, say). Port of `_body_of`.
fn body_of<'a>(ctx: &'a Ctx, func: Node<'a>) -> Node<'a> {
    ctx.children(func).into_iter().find(|c| is_body(c.kind())).unwrap_or(func)
}

fn span(ctx: &Ctx, n: Node) -> (usize, usize) {
    (ctx.line_of(n.start_byte()), ctx.line_of(n.end_byte()))
}

/// The anchor's inner functions, each with the identifiers it mentions. Only the function's OWN nested
/// functions are collected — the walk stops descending once it finds one, so a closure inside a closure
/// belongs to its parent atom rather than becoming a third sibling. Atoms straying outside `[start, end]`
/// are dropped: the anchor's recorded range is the authority on what belongs to it.
///
/// Port of `extract_atoms`. Returns empty (never an error) when the language has no grammar or the anchor
/// line matches no function — an anchor that cannot be decomposed simply has no subcores.
pub fn extract_atoms(content: &str, lang: &str, start_line: usize, end_line: usize) -> Vec<Atom> {
    let Some(ctx) = Ctx::parse(content, lang) else { return Vec::new() };
    let Some(func) = anchor_func(&ctx, start_line) else { return Vec::new() };
    let body = body_of(&ctx, func);

    let mut funcs: Vec<Node> = Vec::new();
    let mut stack: Vec<Node> = ctx.children(body);
    stack.reverse(); // children in source order once popped
    while let Some(n) = stack.pop() {
        if is_funclike(n.kind()) {
            funcs.push(n);
        } else {
            let mut kids = ctx.children(n);
            kids.reverse();
            stack.extend(kids);
        }
    }

    funcs
        .into_iter()
        .filter_map(|n| {
            let (s, e) = span(&ctx, n);
            if s < start_line || e > end_line {
                return None;
            }
            // "identifier" as a SUBSTRING, matching the TS predicate: it catches `identifier`,
            // `property_identifier`, `type_identifier`, `field_identifier` and every grammar's variant
            // without a per-grammar list to keep in step.
            let names = ctx.collect(n, |k| k.contains("identifier")).into_iter().map(|i| ctx.text(i).to_string()).collect();
            Some(Atom { start: s, end: e, names })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = r#"
export function godObject(input) {
  const auth = (u) => { return validate(u, token); };
  const check = (u) => { return token && validate(u); };
  const price = (o) => { return o.total * rate; };
  return { auth, check, price };
}
"#;

    // The atoms of a god-object anchor are its INNER functions, each carrying the names it mentions — that
    // name overlap is the only structure left to cluster on once the call graph has run out of seams.
    #[test]
    fn the_inner_functions_of_the_anchor_become_atoms_with_their_identifiers() {
        let atoms = extract_atoms(SRC, "typescript", 1, 6);
        assert_eq!(atoms.len(), 3, "three arrow functions: {atoms:?}");
        assert!(atoms[0].names.contains("validate") && atoms[0].names.contains("token"));
        assert!(atoms[2].names.contains("rate"));
        // shared names are what will cluster auth+check together and leave price apart
        assert!(atoms[1].names.contains("token"));
        assert!(!atoms[2].names.contains("token"));
        // spans are 0-based lines, ascending, inside the anchor range
        assert!(atoms.windows(2).all(|w| w[0].start <= w[1].start));
        assert!(atoms.iter().all(|a| a.start >= 1 && a.end <= 6));
    }

    // The anchor range is the AUTHORITY: a function outside it belongs to a different anchor, and letting it
    // in would attribute another unit's internals to this one.
    #[test]
    fn a_function_outside_the_anchor_range_is_not_an_atom() {
        let atoms = extract_atoms(SRC, "typescript", 1, 3);
        assert!(atoms.iter().all(|a| a.end <= 3), "{atoms:?}");
        assert!(atoms.len() < 3);
    }

    // The 3-line tolerance absorbs a decorator or an `export` prefix shifting the recorded start; beyond it,
    // the nearest function is a DIFFERENT one and decomposing it would answer about the wrong code.
    #[test]
    fn an_anchor_line_far_from_any_function_decomposes_nothing() {
        assert!(extract_atoms(SRC, "typescript", 40, 60).is_empty());
    }

    // No grammar → no atoms, not a panic. The caller treats an undecomposable anchor as simply having no
    // subcores, which is how an unsupported language degrades instead of failing the whole decompose.
    #[test]
    fn an_unknown_language_yields_no_atoms_rather_than_failing() {
        assert!(extract_atoms(SRC, "cobol", 1, 6).is_empty());
    }
}
