//! ATOMS — the tree-sitter substrate for INTRA-anchor decomposition. Everything else in the engine cuts
//! between units; this cuts *inside* one. A god-object method is a wall of code with no seams the call graph
//! can see, and the only structure left to read is which of its inner functions touch the same names.
//!
//! Port of `atoms.ts`'s extraction half. The node-KIND vocabulary it also carried lives in `node_kinds`
//! already, so only the extractors move here.

use crate::node_kinds::{is_body, is_call, is_funclike, is_param_list, is_param_node};
use crate::treesitter::Ctx;
use once_cell::sync::Lazy;
use regex::Regex;
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

/// One external name the anchor's boundary depends on, and where it is used.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContractMember {
    pub name: String,
    /// Ever used as a CALL target inside the body — the difference between a value the anchor reads and a
    /// collaborator it drives, which is what makes it a `link` rather than an `environment` member.
    pub invoked: bool,
    /// Merged, sorted `[start, end]` line ranges of its occurrences.
    pub ranges: Vec<(usize, usize)>,
}

/// The parameter-list node. BFS from the function, refusing to descend into a nested BODY or a nested
/// FUNCTION — otherwise a closure declared in a default-argument position offers its own parameter list first
/// and the anchor ends up with someone else's signature. Port of `_param_list`.
fn param_list<'a>(ctx: &'a Ctx, func: Node<'a>) -> Option<Node<'a>> {
    let mut queue: std::collections::VecDeque<Node> = ctx.children(func).into_iter().collect();
    while let Some(c) = queue.pop_front() {
        let k = c.kind();
        if is_param_list(k) {
            return Some(c);
        }
        if is_body(k) || is_funclike(k) {
            continue;
        }
        queue.extend(ctx.children(c));
    }
    None
}

/// The name(s) a single parameter binds: its destructured fields if it has any, else its LAST identifier.
/// Last, because on a typed parameter (`x: Foo`) the type reference is an `identifier` too and comes first —
/// taking the first would put the TYPE into the contract instead of the parameter. Port of `_param_names`.
fn param_names(ctx: &Ctx, param: Node) -> Vec<String> {
    let fields = ctx.collect(param, |k| k.contains("shorthand_property_identifier_pattern"));
    if !fields.is_empty() {
        return fields.into_iter().map(|f| ctx.text(f).to_string()).collect();
    }
    let mut ids = ctx.collect(param, |k| k == "identifier");
    ids.sort_by_key(|n| n.start_byte());
    ids.last().map(|n| vec![ctx.text(*n).to_string()]).unwrap_or_default()
}

/// Collapse line numbers into sorted, merged ranges. ADJACENT lines merge as well as duplicates (`l <= end+1`),
/// so a name used on lines 3 and 4 reports one range rather than two — the output is read by a human scanning
/// where a member is touched, and a run of single-line ranges obscures that. Port of `_merge_lines`.
fn merge_lines(lines: &[usize]) -> Vec<(usize, usize)> {
    let mut uniq: Vec<usize> = lines.to_vec();
    uniq.sort_unstable();
    uniq.dedup();
    let mut out: Vec<(usize, usize)> = Vec::new();
    for l in uniq {
        match out.last_mut() {
            Some(last) if l <= last.1 + 1 => last.1 = l,
            _ => out.push((l, l)),
        }
    }
    out
}

/// The anchor's CONTRACT: the external names its boundary depends on.
///
/// Three sources, and the third is the one that matters. A plain parameter is a dependency; a destructured
/// signature parameter contributes its FIELDS; and a parameter destructured in the BODY (`const { a, b } =
/// props`) contributes those fields while the parameter itself DROPS OUT — it was only ever a pass-through,
/// and reporting both would claim a dependency on the container as well as on what was taken from it.
///
/// Members are sorted by name, and one with no occurrence in the body is omitted entirely. Port of
/// `extract_contract`.
pub fn extract_contract(content: &str, lang: &str, start_line: usize, end_line: usize) -> Vec<ContractMember> {
    let _ = end_line; // the TS signature takes it but the contract is derived from the function node alone
    let Some(ctx) = Ctx::parse(content, lang) else { return Vec::new() };
    let Some(func) = anchor_func(&ctx, start_line) else { return Vec::new() };
    let body = body_of(&ctx, func);

    let mut sig_fields: BTreeSet<String> = BTreeSet::new();
    let mut plain_params: BTreeSet<String> = BTreeSet::new();
    if let Some(plist) = param_list(&ctx, func) {
        for p in ctx.children(plist) {
            if !is_param_node(p.kind()) && p.kind() != "identifier" {
                continue;
            }
            let destructured = !ctx.collect(p, |k| k.contains("object_pattern")).is_empty();
            for n in param_names(&ctx, p) {
                if destructured { sig_fields.insert(n); } else { plain_params.insert(n); }
            }
        }
    }

    let mut body_fields: BTreeSet<String> = BTreeSet::new();
    let mut sources: BTreeSet<String> = BTreeSet::new();
    for d in ctx.collect(body, |k| k == "variable_declarator") {
        let ch = ctx.children(d);
        if ch.len() < 2 {
            continue;
        }
        let (pat, val) = (ch[0], ch[ch.len() - 1]);
        if pat.kind().contains("object_pattern") && val.kind() == "identifier" && plain_params.contains(ctx.text(val)) {
            sources.insert(ctx.text(val).to_string());
            for f in ctx.collect(pat, |k| k.contains("shorthand_property_identifier_pattern")) {
                body_fields.insert(ctx.text(f).to_string());
            }
        }
    }

    let contract: BTreeSet<String> = sig_fields
        .into_iter()
        .chain(body_fields)
        .chain(plain_params.iter().filter(|p| !sources.contains(*p)).cloned())
        .collect();
    if contract.is_empty() {
        return Vec::new();
    }

    let idents = ctx.collect(body, |k| k.contains("identifier"));
    let called: std::collections::HashSet<String> = ctx
        .collect(body, |k| is_call(k))
        .into_iter()
        .filter_map(|c| ctx.children(c).first().copied())
        .filter(|f| f.kind().contains("identifier"))
        .map(|f| ctx.text(f).to_string())
        .collect();

    contract
        .into_iter()
        .filter_map(|name| {
            let occ: Vec<usize> = idents.iter().filter(|i| ctx.text(**i) == name).map(|i| ctx.line_of(i.start_byte())).collect();
            if occ.is_empty() {
                return None;
            }
            Some(ContractMember { invoked: called.contains(&name), ranges: merge_lines(&occ), name })
        })
        .collect()
}

/// What a CALLER binds into the anchor's tag/attribute form, dispatched to the file's language provider.
/// A language with no such concept (Java, Ruby, Python — arguments are positional there, and no tag names the
/// callee's parameters) returns nothing, which is the honest answer rather than a gap. Port of
/// `extract_consumer_feeds`.
pub fn extract_consumer_feeds(content: &str, file: &str, anchor_name: &str) -> Vec<(String, crate::types::Feed)> {
    let Some(provider) = crate::provider_for(file) else { return Vec::new() };
    let Some(lang) = crate::grammar_for(file) else { return Vec::new() };
    let Some(ctx) = Ctx::parse(content, lang) else { return Vec::new() };
    provider.consumer_feeds(&ctx, anchor_name)
}

// ── DYNAMIC-DISPATCH DETECTION ───────────────────────────────────────────────────────────────────────────
// Two blind spots static resolution cannot thread, both TS/JS-only and both purely SYNTACTIC — a code SHAPE,
// never a guess at a name's meaning.

/// TS/JS source extensions. `import()` is a JS/TS-only construct, so these scans are genuinely language-bound
/// rather than a generic walk that happens to be applied to one language.
pub const TS_EXTENSIONS: &[&str] = &[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

fn stem_of(p: &str) -> &str {
    let b = p.rsplit('/').next().unwrap_or(p);
    match b.rfind('.') {
        Some(i) if i > 0 => &b[..i],
        _ => b,
    }
}

/// A quoted, string-literal dynamic import: `import("./x")`.
static DYNAMIC_IMPORT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"import\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap());

/// Files that dynamically import the anchor by STRING PATH — a load the reference resolver cannot see, so it
/// is surfaced as a SUGGESTED blind spot and never as a resolved edge.
///
/// `resolved` is the set of files that ALREADY have a resolved edge into the anchor, and excluding them is the
/// point: a literal `import("./x")` resolves like a static import and the TypeScript resolver already follows
/// it, so reporting those again would contradict the graph's own edge with a "cannot see this" claim. Only the
/// genuinely-unresolved residue is a real blind spot. Returns `(rel, 1-based line)`, capped.
pub fn dynamic_import_candidates(repo: &str, anchor_rel: &str, resolved: &std::collections::HashSet<String>, cap: usize) -> Vec<(String, usize)> {
    let stem = stem_of(anchor_rel);
    if stem.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for rel in seam_fs::source_files(repo, |r| TS_EXTENSIONS.iter().any(|e| r.ends_with(e))) {
        if out.len() >= cap {
            break;
        }
        if rel == anchor_rel || resolved.contains(&rel) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(format!("{repo}/{rel}")) else { continue };
        // cheap reject before the regex: both substrings must be present at all
        if !text.contains("import(") || !text.contains(stem) {
            continue;
        }
        for (idx, line) in text.lines().enumerate() {
            if !line.contains("import(") {
                continue;
            }
            for c in DYNAMIC_IMPORT_RE.captures_iter(line) {
                if stem_of(&c[1]) == stem {
                    out.push((rel.clone(), idx + 1));
                }
            }
        }
    }
    out.truncate(cap);
    out
}

/// A dynamic import of a NON-literal: `import(x)` where x is not a quoted string. A literal is statically
/// resolvable and already followed, so only the non-literal form is a blind spot.
static DYN_IMPORT_NONLITERAL: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bimport\(\s*[^'"\s)]"#).unwrap());

/// The identifiers a file IMPORTS — named, aliased and default. A registry subscript only counts when its
/// receiver came from another module: a local `arr[i]` is data, an imported `REG[key]` is a dispatch table.
pub fn imported_idents(text: &str) -> Vec<String> {
    static NAMED: Lazy<Regex> = Lazy::new(|| Regex::new(r"import\s+(?:type\s+)?\{([^}]*)\}\s+from").unwrap());
    static DEFAULT: Lazy<Regex> = Lazy::new(|| Regex::new(r"import\s+(\w+)\s*(?:,|from)").unwrap());
    static WORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\w+$").unwrap());
    // ORDER IS THE TS `Set`'s INSERTION ORDER — all named/aliased bindings in match order, then the default
    // imports — because `dynamic_dispatch_evidence` names ONE registry and picks the first that matches. A
    // sorted or hashed order would name a different one on a body that dispatches through two, which is a
    // silent change to the emitted sentence rather than a fix.
    let mut out: Vec<String> = Vec::new();
    let mut push = |n: String, out: &mut Vec<String>| { if !out.contains(&n) { out.push(n); } };
    for c in NAMED.captures_iter(text) {
        for part in c[1].split(',') {
            let nm = part.trim().split(" as ").last().unwrap_or("").trim();
            if WORD.is_match(nm) {
                push(nm.to_string(), &mut out);
            }
        }
    }
    for c in DEFAULT.captures_iter(text) {
        push(c[1].to_string(), &mut out);
    }
    out
}

/// Why a node's body DISPATCHES OUT through something static resolution cannot thread — or `None`.
///
/// Shape B (the registry) needs its ACTIVATION check, and that check is what makes the pass usable. A
/// subscript of an imported map by a runtime key has the same syntax whether it yields a service class or a
/// scalar: `PaymentServiceMap[key]` and `ErrorCode[key]` are indistinguishable by shape alone. Only the first
/// is a blind spot, because only it resolves to an impl with a data sink — so the result must be ACTIVATED as
/// code (awaited, called, constructed, or dynamically imported), either directly or through a `const X =
/// REG[key]` binding. Without that, every enum lookup in the repo reads as a lost flow.
pub fn dynamic_dispatch_evidence(body: &str, imports: &[String]) -> Option<String> {
    if DYN_IMPORT_NONLITERAL.is_match(body) {
        return Some("dynamic-imports a non-literal module path".to_string());
    }
    // IN THE CALLER'S ORDER (see `imported_idents`) — the evidence names ONE registry, and the first match
    // wins, so the iteration order is part of the answer rather than an implementation detail.
    for ident in imports {
        let esc = regex::escape(ident);
        let sub = format!(r#"{esc}\[\s*[^\]'"\s][^\]]*\]"#); // REG[<non-literal key>]
        let direct = Regex::new(&format!(r"(?:await\s+|new\s+|import\(\s*){sub}|{sub}\s*\(")).ok()?;
        let mut hit = direct.is_match(body);
        if !hit {
            let bind = Regex::new(&format!(r"(?:const|let|var)\s+(\w+)\s*=\s*{sub}")).ok()?;
            for c in bind.captures_iter(body) {
                let v = regex::escape(&c[1]);
                let used = Regex::new(&format!(r"(?:await\s+{v}\b|\b{v}\s*\(|new\s+{v}\b|import\(\s*{v}\b)")).ok()?;
                if used.is_match(body) {
                    hit = true;
                    break;
                }
            }
        }
        if hit {
            return Some(format!("dispatches through the imported registry `{ident}[…]`"));
        }
    }
    None
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

    const JSX: &str = "export function Page({ user }) {\n  return (\n    <div>\n      <Widget id={user.id} label=\"hello\" flag onSave={() => save(user)} />\n      <ns.Widget id={user.id} />\n      <widget id={user.id} />\n    </div>\n  );\n}\n";

    // A CONSUMER'S BINDINGS are how a reader gets from "this prop exists" to "here is what is passed, at this
    // position". The three attribute shapes each carry a different amount of information and all three are
    // load-bearing.
    #[test]
    fn jsx_attributes_become_feeds_with_the_value_expression_unwrapped() {
        let feeds = extract_consumer_feeds(JSX, "page.tsx", "Widget");
        let by = |n: &str| feeds.iter().find(|(p, _)| p == n).map(|(_, f)| f.clone());

        // EXPRESSION: the braces are unwrapped, so the feed reads the expression a human would type
        let id = by("id").expect("id");
        assert_eq!(id.value, "user.id", "not the braced form");
        assert_eq!((id.val_line, id.val_col), (Some(3), Some(18)));

        // STRING: quotes are KEPT — the value is a literal, and stripping them would make it indistinguishable
        // from an identifier of the same text
        assert_eq!(by("label").unwrap().value, "\"hello\"");

        // BARE: JSX shorthand for `true`. Recorded, because the consumer really did bind it — but with NO
        // value position, since there is no value expression to point at. Absent, never 0: line 0 is a real
        // line, and a reader sent there would land on the wrong code.
        let flag = by("flag").expect("a valueless attribute is still a binding");
        assert_eq!(flag.value, "true");
        assert_eq!((flag.val_line, flag.val_col), (None, None));

        // an arrow value keeps its whole expression, which is what makes the feed worth reading
        assert_eq!(by("onSave").unwrap().value, "() => save(user)");
    }

    // The tag must match the anchor EXACTLY. `ns.Widget` is a different component reached through a namespace,
    // and `widget` is a DOM element — attributing either one's props to the anchor would put a stranger's
    // bindings in its contract.
    #[test]
    fn only_an_exactly_matching_tag_contributes_feeds() {
        assert_eq!(extract_consumer_feeds(JSX, "page.tsx", "Widget").len(), 4);
        assert_eq!(extract_consumer_feeds(JSX, "page.tsx", "ns.Widget").len(), 1);
        assert!(extract_consumer_feeds(JSX, "page.tsx", "Nothing").is_empty());
    }

    // A language with no attribute-binding concept returns NOTHING rather than guessing. Java, Ruby and Python
    // pass arguments positionally; there is no tag whose attributes name the callee's parameters, so an empty
    // answer is the honest one.
    #[test]
    fn a_language_without_the_concept_yields_no_feeds() {
        assert!(extract_consumer_feeds("class A { void f(B b) { b.g(1); } }", "A.java", "g").is_empty());
        assert!(extract_consumer_feeds(JSX, "page.rb", "Widget").is_empty());
    }

    fn imps(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    // THE ACTIVATION CHECK IS THE WHOLE PASS. `PaymentServiceMap[key]` and `ErrorCode[key]` are the SAME
    // syntax; only the first resolves to an impl with a data sink. Without requiring the result to be
    // activated as code, every enum lookup in a repo would read as a lost flow and the blind-spot list would
    // be worthless.
    #[test]
    fn an_imported_registry_is_a_blindspot_only_when_its_result_is_activated() {
        let reg = imps(&["PaymentServiceMap", "ErrorCode"]);
        for body in [
            "const s = await PaymentServiceMap[key];",
            "new PaymentServiceMap[key]();",
            "return PaymentServiceMap[key](arg);",
            "await import(PaymentServiceMap[key]);",
        ] {
            assert!(dynamic_dispatch_evidence(body, &reg).is_some(), "activated: {body}");
        }
        // a SCALAR lookup — identical shape, never an impl
        assert!(dynamic_dispatch_evidence("const msg = ErrorCode[key];", &reg).is_none());
        assert!(dynamic_dispatch_evidence("log(ErrorCode[key]);", &reg).is_none());
    }

    // The activation may be one hop away: `const X = REG[key]` then `await X`. Tracking the binding is what
    // catches the idiomatic form, which is how this is actually written.
    #[test]
    fn a_bound_registry_lookup_counts_when_the_binding_is_activated() {
        let reg = imps(&["ServiceMap"]);
        assert!(dynamic_dispatch_evidence("const Svc = ServiceMap[key];\nconst s = await Svc;", &reg).is_some());
        assert!(dynamic_dispatch_evidence("const Svc = ServiceMap[key];\nreturn Svc.name;", &reg).is_none(), "read, not activated");
    }

    // A LOCAL array is data, not a dispatch table. The receiver must have come from another module — that is
    // what makes it a registry rather than a list someone is indexing.
    #[test]
    fn a_local_subscript_is_not_a_registry_dispatch() {
        assert!(dynamic_dispatch_evidence("const x = await arr[i];", &imps(&["Other"])).is_none());
        // …and a LITERAL key is statically resolvable, so it is not a blind spot either
        assert!(dynamic_dispatch_evidence("await ServiceMap[\"stripe\"]();", &imps(&["ServiceMap"])).is_none());
    }

    // A dynamic import of a LITERAL resolves statically and is already followed; only the non-literal is blind.
    #[test]
    fn only_a_non_literal_dynamic_import_is_a_blindspot() {
        let none = imps(&[]);
        assert!(dynamic_dispatch_evidence("const m = await import(modulePath);", &none).is_some());
        assert!(dynamic_dispatch_evidence("const m = await import('./known');", &none).is_none());
    }

    #[test]
    fn imported_idents_reads_named_aliased_and_default_forms() {
        let got = imported_idents("import React from 'react';\nimport { a, b as c } from './x';\nimport type { T } from './t';\n");
        // NAMED bindings first in match order, then defaults — the TS Set's insertion order, which decides
        // which registry the evidence names when two could match
        assert_eq!(got, ["a", "c", "T", "React"], "alias binds the LOCAL name; order is insertion, not sorted");
    }

    // Evidence names ONE registry, and WHICH one is the caller's import order — not sorted, not hashed. The
    // TypeScript walked a Set in insertion order and the first match won; reproducing that is what keeps the
    // emitted sentence identical on a body that dispatches through two.
    #[test]
    fn the_named_registry_follows_import_order_when_two_could_match() {
        let body = "await Alpha[k](); await Zeta[k]();";
        assert!(dynamic_dispatch_evidence(body, &imps(&["Zeta", "Alpha"])).unwrap().contains("Zeta"));
        assert!(dynamic_dispatch_evidence(body, &imps(&["Alpha", "Zeta"])).unwrap().contains("Alpha"));
    }

    // A BODY-DESTRUCTURED PARAM DROPS OUT in favour of its fields. `props` was only ever a pass-through, and
    // reporting it alongside `a`/`b` would claim a dependency on the container as well as on what was taken
    // from it — two entries for one boundary fact.
    #[test]
    fn a_param_destructured_in_the_body_yields_its_fields_and_not_itself() {
        let src = "function f(props, other) {\n  const { a, b } = props;\n  return a + b + other;\n}\n";
        let ms = extract_contract(src, "typescript", 0, 3);
        let names: Vec<&str> = ms.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "other"], "props is the source, not a member");
    }

    // On a TYPED parameter the type reference is an `identifier` too, and it comes FIRST. Taking the first
    // would put `Foo` — a type, not a dependency — into the contract.
    #[test]
    fn a_typed_param_contributes_its_name_not_its_type() {
        let src = "function f(x: Foo, y: Bar) {\n  return x + y;\n}\n";
        let ms = extract_contract(src, "typescript", 0, 2);
        let names: Vec<&str> = ms.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["x", "y"]);
    }

    // A destructured SIGNATURE param contributes its fields directly, and `invoked` separates a collaborator
    // the anchor DRIVES from a value it merely reads — the distinction that makes one a `link` member and the
    // other `environment`.
    #[test]
    fn signature_destructuring_contributes_fields_and_invoked_marks_the_ones_called() {
        let src = "function f({ save, label }) {\n  save(label);\n  return label;\n}\n";
        let ms = extract_contract(src, "typescript", 0, 3);
        let by = |n: &str| ms.iter().find(|m| m.name == n).unwrap_or_else(|| panic!("missing {n}: {ms:?}"));
        assert!(by("save").invoked, "called → a collaborator");
        assert!(!by("label").invoked, "read → environment");
    }

    // ADJACENT lines merge, so a member used on 1 and 2 reports one range. The output is read by a human
    // scanning where a dependency is touched; a run of single-line ranges obscures exactly that.
    #[test]
    fn occurrence_lines_merge_when_adjacent_and_split_when_not() {
        assert_eq!(merge_lines(&[3, 1, 2, 2]), vec![(1, 3)]);
        assert_eq!(merge_lines(&[1, 5, 6, 9]), vec![(1, 1), (5, 6), (9, 9)]);
        assert_eq!(merge_lines(&[]), vec![]);
    }

    // A name in the signature but never used in the body is NOT a contract member: the boundary depends on
    // what the code actually touches, not on what it declared and ignored.
    #[test]
    fn an_unused_parameter_is_not_a_contract_member() {
        let src = "function f(used, ignored) {\n  return used;\n}\n";
        let ms = extract_contract(src, "typescript", 0, 2);
        let names: Vec<&str> = ms.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["used"]);
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
