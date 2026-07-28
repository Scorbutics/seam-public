//! ATOMS — the tree-sitter substrate for INTRA-anchor decomposition. Everything else in the engine cuts
//! between units; this cuts *inside* one. A god-object method is a wall of code with no seams the call graph
//! can see, and the only structure left to read is which of its inner functions touch the same names.
//!
//! Port of `atoms.ts`'s extraction half. The node-KIND vocabulary it also carried lives in `node_kinds`
//! already, so only the extractors move here.

use crate::node_kinds::{is_body, is_funclike};
use crate::treesitter::Ctx;
use std::collections::{BTreeSet, HashMap, HashSet};
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

/// One proposed INTERNAL cut of a god-object anchor: a clique of its atoms that share names nothing else in
/// the function touches. `proposed` on the TS side is always true — these are suggestions for a reviewer, not
/// resolved structure — so it is not carried here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subcore {
    pub id: String,
    pub label: String,
    /// `[start, end]` line ranges of the member atoms, in atom order.
    pub ranges: Vec<(usize, usize)>,
    /// The distinctive names the clique reads — sorted, deduped. Its first element is the label.
    pub reads: Vec<String>,
}

/// Cluster an anchor's atoms into subcores by SHARED DISTINCTIVE NAMES.
///
/// AMBIENT NAMES ARE EXCLUDED FIRST, and that is the whole trick. A name more than half the atoms mention is
/// the function's own scaffolding — its parameter, its logger, its accumulator — and clustering on it would
/// join every atom into one useless blob. What is left is the vocabulary specific to a subset, and atoms
/// sharing it are doing one job together.
///
/// Returns EMPTY when there are fewer than 2 atoms, or when everything lands in a single group: "this anchor
/// has one internal concern" is not a decomposition, and proposing a single subcore covering the whole body
/// would be noise dressed as a finding. Port of `detect_subcores`' pure half.
pub fn subcores(atoms: &[Atom]) -> Vec<Subcore> {
    if atoms.len() < 2 {
        return Vec::new();
    }
    // STRICTLY more than half — `cut` is floor(n/2) (min 1) and the test is `> cut`, so on 4 atoms a name in
    // 3 is ambient and a name in 2 is not. Deliberately not `>=`: a name shared by exactly half is the
    // strongest possible two-way split signal, and treating it as scaffolding would erase the cut.
    let cut = std::cmp::max(1, atoms.len() / 2);
    let mut freq: HashMap<&str, usize> = HashMap::new();
    for a in atoms {
        for n in &a.names {
            *freq.entry(n.as_str()).or_insert(0) += 1;
        }
    }
    let ambient: HashSet<&str> = freq.iter().filter(|(_, c)| **c > cut).map(|(n, _)| *n).collect();

    // union-find over atom indices, joined wherever a distinctive name co-occurs
    let mut parent: Vec<usize> = (0..atoms.len()).collect();
    fn find(parent: &mut Vec<usize>, x: usize) -> usize {
        if parent[x] != x {
            let r = find(parent, parent[x]);
            parent[x] = r;
        }
        parent[x]
    }
    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, a) in atoms.iter().enumerate() {
        for n in a.names.iter().filter(|n| !ambient.contains(n.as_str())) {
            by_name.entry(n.as_str()).or_default().push(i);
        }
    }
    for members in by_name.values() {
        for &m in &members[1..] {
            let (ra, rb) = (find(&mut parent, members[0]), find(&mut parent, m));
            if ra != rb {
                parent[ra] = rb;
            }
        }
    }

    // group ids are assigned in ATOM order — `g1` to the first atom's root — matching the TS
    // `connected_components` numbering, which walks its `nodes` array in order.
    let mut root_to_group: HashMap<usize, String> = HashMap::new();
    let mut group_of: Vec<String> = Vec::with_capacity(atoms.len());
    for i in 0..atoms.len() {
        let r = find(&mut parent, i);
        let next = root_to_group.len() + 1;
        group_of.push(root_to_group.entry(r).or_insert_with(|| format!("g{next}")).clone());
    }
    if root_to_group.len() < 2 {
        return Vec::new();
    }

    let mut by_group: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, g) in group_of.iter().enumerate() {
        by_group.entry(g.as_str()).or_default().push(i);
    }
    // LEXICOGRAPHIC, not numeric — the TS side sorts the group-id STRINGS, so past nine groups the order runs
    // g1, g10, g11, g2. Reproduced exactly rather than "fixed": the emitted order is part of the answer, and
    // changing it here would be a silent render diff dressed as a bug fix.
    let mut keys: Vec<&str> = by_group.keys().copied().collect();
    keys.sort();

    keys.into_iter()
        .map(|gid| {
            let idxs = &by_group[gid];
            let reads: Vec<String> = idxs
                .iter()
                .flat_map(|&i| atoms[i].names.iter().filter(|n| !ambient.contains(n.as_str())).cloned())
                .collect::<BTreeSet<String>>()
                .into_iter()
                .collect();
            Subcore {
                id: gid.to_string(),
                label: reads.first().cloned().unwrap_or_else(|| gid.to_string()),
                ranges: idxs.iter().map(|&i| (atoms[i].start, atoms[i].end)).collect(),
                reads,
            }
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

    fn atom(start: usize, names: &[&str]) -> Atom {
        Atom { start, end: start, names: names.iter().map(|s| s.to_string()).collect() }
    }

    // THE POINT OF THE PASS: two cliques inside one function, found because each shares vocabulary the other
    // does not. `input` is in every atom — scaffolding — and clustering on it would fuse everything into one
    // group and report nothing.
    #[test]
    fn atoms_sharing_distinctive_names_cluster_and_ambient_names_do_not_fuse_them() {
        let atoms = [
            atom(1, &["input", "token", "validate"]),
            atom(2, &["input", "token", "validate"]),
            atom(3, &["input", "rate", "total"]),
            atom(4, &["input", "rate", "total"]),
        ];
        let out = subcores(&atoms);
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[0].id, "g1");
        assert_eq!(out[0].ranges, vec![(1, 1), (2, 2)]);
        assert_eq!(out[0].reads, vec!["token", "validate"]);
        assert_eq!(out[0].label, "token", "the label is the first distinctive name");
        assert_eq!(out[1].ranges, vec![(3, 3), (4, 4)]);
        assert_eq!(out[1].reads, vec!["rate", "total"]);
        // `input` is in all four (4 > cut=2) → ambient, and appears in NO subcore's reads
        assert!(out.iter().all(|s| !s.reads.contains(&"input".to_string())));
    }

    // A name in exactly HALF the atoms is the strongest two-way split signal there is. The threshold is
    // `> floor(n/2)`, not `>=`, precisely so it survives — treating it as scaffolding would erase the cut
    // this pass exists to find.
    #[test]
    fn a_name_shared_by_exactly_half_the_atoms_still_clusters_them() {
        let atoms = [
            atom(1, &["shared"]),
            atom(2, &["shared"]),
            atom(3, &["other"]),
            atom(4, &["other"]),
        ];
        let out = subcores(&atoms);
        assert_eq!(out.len(), 2, "2 of 4 is not ambient: {out:?}");
        assert_eq!(out[0].reads, vec!["shared"]);
    }

    // ONE group is not a decomposition. Reporting a single subcore spanning the whole body would be noise
    // presented as a finding, so the pass abstains.
    #[test]
    fn a_single_clique_is_no_decomposition_at_all() {
        assert!(subcores(&[atom(1, &["a"])]).is_empty(), "one atom cannot be split");
        assert!(subcores(&[]).is_empty());
        // a CHAIN of distinctive names (x joins 1-2, y joins 2-3, z joins 3-4) pulls all four atoms into one
        // group — transitively, which is why this is union-find and not pairwise overlap — so there is no cut
        // to propose. Each name sits in exactly 2 of 4, under the `> 2` ambient threshold.
        assert!(subcores(&[atom(1, &["x"]), atom(2, &["x", "y"]), atom(3, &["y", "z"]), atom(4, &["z"])]).is_empty());
    }

    // DEGENERATE, AND REPRODUCED ON PURPOSE. When every name is ambient there is nothing left to join on, so
    // each atom falls out as its own group and the pass emits labelless singletons — `reads` empty, `label`
    // the bare group id. That is what the TypeScript does (checked against `connected_components` directly,
    // not assumed), so it is what this does. Pinned because it is the shape most likely to be "tidied up" by
    // someone reading the code later, which would be a silent behaviour change rather than a fix.
    #[test]
    fn when_every_name_is_ambient_each_atom_becomes_a_labelless_singleton() {
        let out = subcores(&[atom(1, &["a", "b"]), atom(2, &["a", "b"])]);
        assert_eq!(out.len(), 2, "{out:?}");
        assert!(out.iter().all(|s| s.reads.is_empty()));
        assert_eq!(out.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["g1", "g2"]);
    }

    // GROUP ORDER IS LEXICOGRAPHIC ON THE ID STRING, so ten or more groups run g1, g10, g11, g2 — not g1, g2,
    // …, g10. That is what the TypeScript emits and what the snapshot gate pins; "fixing" it to numeric order
    // here would be a silent render diff. Pinned so the quirk cannot be lost by accident.
    #[test]
    fn ten_or_more_groups_are_ordered_lexicographically_as_the_typescript_emits_them() {
        // 11 mutually-disjoint atoms → 11 singleton groups
        let names: Vec<String> = (0..11).map(|i| format!("n{i}")).collect();
        let atoms: Vec<Atom> = names.iter().enumerate().map(|(i, n)| atom(i, &[n.as_str()])).collect();
        let out = subcores(&atoms);
        assert_eq!(out.len(), 11);
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids[..4], ["g1", "g10", "g11", "g2"], "lexicographic, not numeric: {ids:?}");
    }

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
