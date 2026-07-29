//! STRUCTURAL PRE-CLUSTERING of floor-blind files — port of `coupling/key_cluster.ts` (Phase 2 of the Rust
//! flywheel port). Deterministic tree-sitter shape scan (NO LLM): groups floor-blind files by their dominant
//! data-access SHAPE (the receiver of a member CHAIN / string-keyed call) so the flywheel LLM's only ONE
//! representative per pattern; the rest ground via the learned rule. The GROUPING is structural (a closed set of
//! call-shapes from the node-kind registry — never a regex over meaning); naming/role stays the LLM's job.
//!
//! Rust native grammars are ALWAYS available, so the TS `!available()` degrade-to-one-cluster-per-file branch
//! never fires here. The shape gate (drop a file with no coupling signal) is DEFAULT-ON (SEAM_COUPLING_SHAPE_GATE=0
//! opts out), matching TS.

use seam_lang::node_kinds::{is_call, is_member, is_name_kind, is_string_kind};
use seam_lang::{grammar_for, Ctx, Node};
use std::collections::HashMap;

// Cross-language self-reference keywords — a member chain rooted at `this`/`self`/`super` is too common to be a
// distinctive cluster signature. Port of `_SELF_REFS`.
fn is_self_ref(s: &str) -> bool {
    matches!(s, "this" | "self" | "super")
}
// Argument-list wrapper kinds. Port of `_ARGS`.
fn is_args(k: &str) -> bool {
    matches!(k, "arguments" | "argument_list")
}
// Ruby constants / Java scoped names a call receiver can be, beyond `_NAME_KINDS`. Port of `_NAMEISH`.
fn is_nameish(k: &str) -> bool {
    matches!(k, "constant" | "scoped_identifier" | "identifier" | "simple_identifier" | "type_identifier")
}

/// The leftmost identifier of a (possibly nested) member/call expression — the ROOT receiver. Port of `_rootId`.
fn root_id<'a>(ctx: &'a Ctx, node: Node<'a>) -> Option<String> {
    let mut n = node;
    while !is_name_kind(n.kind()) {
        let kids = ctx.children(n);
        let first = *kids.first()?;
        n = first;
    }
    Some(ctx.text(n).to_string())
}

/// Does the call carry a STRING-LITERAL argument of ITS OWN? Descends args but STOPS at a nested call. Port of
/// `_hasStringArg`.
fn has_string_arg<'a>(ctx: &'a Ctx, call: Node<'a>) -> bool {
    let kids = ctx.children(call);
    let Some(args) = kids.iter().find(|c| is_args(c.kind())) else { return false };
    let mut stack = ctx.children(*args);
    while let Some(n) = stack.pop() {
        if is_string_kind(n.kind()) {
            return true;
        }
        if is_call(n.kind()) {
            continue; // a nested call's string belongs to THAT call
        }
        stack.extend(ctx.children(n));
    }
    false
}

struct Receiver {
    recv: String,
    deep: bool,
}

/// The ROOT RECEIVER of a call, cross-grammar (JS member_expression / Java method_invocation / Ruby call). Port
/// of `_callReceiver`. `deep` = a ≥3-level member chain (`prisma.user.find`) — the strongest ORM/repo signal.
fn call_receiver<'a>(ctx: &'a Ctx, call: Node<'a>) -> Option<Receiver> {
    let kids = ctx.children(call);
    if let Some(member_callee) = kids.iter().find(|c| is_member(c.kind())) {
        let root = root_id(ctx, *member_callee)?;
        if is_self_ref(&root) {
            return None;
        }
        let obj = ctx.children(*member_callee).into_iter().next();
        let deep = obj.map_or(false, |o| is_member(o.kind()));
        return Some(Receiver { recv: root, deep });
    }
    let args_idx = kids.iter().position(|c| is_args(c.kind()));
    let slice: &[Node] = match args_idx {
        Some(i) => &kids[..i],
        None => &kids[..],
    };
    let names: Vec<Node> = slice.iter().copied().filter(|c| is_name_kind(c.kind()) || is_nameish(c.kind())).collect();
    if names.len() >= 2 {
        let recv = ctx.text(names[0]).to_string();
        if !recv.is_empty() && !is_self_ref(&recv) {
            return Some(Receiver { recv, deep: names.len() >= 3 });
        }
    }
    None
}

/// A file's structural shape scan. `tokens` = STRICT coupling shapes (deep chain / string-keyed); `weak` = a bare
/// 2-level receiver; `has_signal` = any call at all (lenient discard signal). Port of `_shapeScan`.
pub struct ShapeScan {
    pub tokens: Vec<String>,
    pub weak: Vec<String>,
    pub has_signal: bool,
}

fn shape_scan(ctx: &Ctx) -> ShapeScan {
    let calls = ctx.collect(ctx.root(), is_call);
    let has_signal = !calls.is_empty();
    let mut tokens: Vec<String> = Vec::new();
    let mut weak: Vec<String> = Vec::new();
    for call in calls {
        if let Some(r) = call_receiver(ctx, call) {
            if r.deep || has_string_arg(ctx, call) {
                tokens.push(format!("recv:{}", r.recv));
            } else {
                weak.push(format!("recv:{}", r.recv));
            }
        } else {
            let callee = ctx.children(call).into_iter().find(|c| is_name_kind(c.kind()) || is_nameish(c.kind()));
            if let Some(callee) = callee {
                if has_string_arg(ctx, call) {
                    tokens.push(format!("call:{}", ctx.text(callee)));
                }
            }
        }
    }
    ShapeScan { tokens, weak, has_signal }
}

/// The DOMINANT (most frequent) shape-token — the file's cluster signature. Tie → lexically-least. Port of
/// `_dominant`. Empty when no recognised shape.
fn dominant(tokens: &[String]) -> String {
    if tokens.is_empty() {
        return String::new();
    }
    let mut count: HashMap<&str, usize> = HashMap::new();
    for t in tokens {
        *count.entry(t.as_str()).or_insert(0) += 1;
    }
    // count DESC, then key ASC — a total order (keys unique), so deterministic regardless of map iteration order.
    let mut v: Vec<(&str, usize)> = count.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    v[0].0.to_string()
}

/// A cluster of floor-blind files sharing a dominant structural shape. Indices refer to the input `files` slice.
pub struct BlindCluster {
    pub signature: String,
    pub shaped: bool,
    pub rep: usize,
    pub members: Vec<usize>,
}

/// Cluster floor-blind files by their dominant structural shape. Port of `clusterBlindFiles`. `files` = (relpath,
/// text). Returns clusters sorted by member count DESC (stable — insertion order kept within a size). Shapeless
/// files stay singletons, marked `shaped:false` so the caller drops them (the shape gate, default-on).
pub fn cluster_blind_files(files: &[(String, String)]) -> Vec<BlindCluster> {
    let gate = true;
    struct Entry {
        sig: String,
        richness: usize,
        member: usize,
        shaped: bool,
    }
    // insertion-ordered groups (mirrors the TS Map): first-seen key order, so the final stable sort matches.
    let mut groups: Vec<(String, Vec<Entry>)> = Vec::new();
    let mut key_idx: HashMap<String, usize> = HashMap::new();
    for (i, (file, text)) in files.iter().enumerate() {
        // scan = None ⇒ unsupported lang (no grammar) → can't read → KEEP (shaped). Native tree-sitter never fails
        // to parse a supported grammar, so `scan` is Some for every supported file.
        let scan: Option<ShapeScan> = grammar_for(file).and_then(|g| Ctx::parse(text, g)).map(|ctx| shape_scan(&ctx));
        let sig = match &scan {
            Some(s) => {
                if !s.tokens.is_empty() {
                    dominant(&s.tokens)
                } else {
                    dominant(&s.weak)
                }
            }
            None => String::new(),
        };
        let richness = scan.as_ref().map_or(0, |s| s.tokens.len() + s.weak.len());
        let shaped = !gate || scan.is_none() || scan.as_ref().map_or(false, |s| s.has_signal);
        let key = if shaped {
            if sig.is_empty() {
                format!("\0solo:{file}")
            } else {
                sig.clone()
            }
        } else {
            format!("\0noshape:{file}")
        };
        let gi = *key_idx.entry(key.clone()).or_insert_with(|| {
            groups.push((key.clone(), Vec::new()));
            groups.len() - 1
        });
        groups[gi].1.push(Entry { sig, richness, member: i, shaped });
    }
    let mut clusters: Vec<BlindCluster> = Vec::new();
    for (_, entries) in &groups {
        // richest example = rep; `>` (not `>=`) keeps the FIRST on a tie (matches TS reduce).
        let rep = entries.iter().reduce(|a, b| if b.richness > a.richness { b } else { a }).unwrap();
        clusters.push(BlindCluster {
            signature: rep.sig.clone(),
            shaped: rep.shaped,
            rep: rep.member,
            members: entries.iter().map(|e| e.member).collect(),
        });
    }
    // biggest clusters first (one rep grounds many). Stable sort → insertion order preserved within a size.
    clusters.sort_by(|a, b| b.members.len().cmp(&a.members.len()));
    clusters
}

#[cfg(test)]
mod tests {
    use super::*;

    // STRUCTURAL pre-clustering of floor-blind files — the upfront, deterministic half of the flywheel. Files
    // sharing a data-access SHAPE collapse into ONE cluster so the model reads a single representative and the
    // rest ground via the learned rule. This is what cuts the LLM INPUT (30 near-identical Prisma files → 1)
    // rather than merely caching it. Ported from key_cluster.test.ts, shape_gate.test.ts and
    // cluster_crosslang.test.ts.
    fn f(file: &str, text: &str) -> (String, String) {
        (file.to_string(), text.to_string())
    }
    /// Cluster member FILES (the Rust API returns indices into the input).
    fn members<'a>(c: &BlindCluster, files: &'a [(String, String)]) -> Vec<&'a str> {
        let mut v: Vec<&str> = c.members.iter().map(|&i| files[i].0.as_str()).collect();
        v.sort();
        v
    }
    fn by_sig<'a>(cs: &'a [BlindCluster], sig: &str) -> Option<&'a BlindCluster> {
        cs.iter().find(|c| c.signature == sig)
    }

    #[test]
    fn collapses_same_shape_files_and_keeps_distinct_shapes_separate() {
        let files = vec![
            f("a.ts", "export async function a() { return prisma.eventType.findMany(); }"),
            f("b.ts", "export async function b(x) { await prisma.user.update({ data: x }); }"),
            f("c.ts", "export async function c() { return prisma.booking.create({ data: {} }); }"),
            f("bus.ts", "export function emit() { bus.publish(\"sync.done\", {}); }"), // a distinct shape
            f("plain.ts", "export function add(a, b) { return a + b; }"),              // no data access at all
        ];
        let cs = cluster_blind_files(&files);
        assert_eq!(cs.len(), 3, "3 prisma → 1, bus → 1, plain → 1");

        // Clustered by the RECEIVER (the data object), NOT the model or the verb: findMany/update/create on
        // three different models still share `prisma`, and one rule learned off any of them grounds all three.
        let prisma = by_sig(&cs, "recv:prisma").expect("recv:prisma");
        assert_eq!(members(prisma, &files), vec!["a.ts", "b.ts", "c.ts"]);
        assert!(["a.ts", "b.ts", "c.ts"].contains(&files[prisma.rep].0.as_str()));

        assert!(by_sig(&cs, "recv:bus").map(|c| c.members.len()) == Some(1));
        let shapeless = by_sig(&cs, "").expect("the shapeless singleton");
        assert_eq!(members(shapeless, &files), vec!["plain.ts"]);
    }

    #[test]
    fn a_channels_read_and_write_cluster_together_so_one_rep_teaches_the_pair() {
        let files = vec![
            f("r.ts", "export function load() { return JSON.parse(localStorage.getItem(\"draft\")); }"),
            f("w.ts", "export function save(v) { localStorage.setItem(\"draft\", JSON.stringify(v)); }"),
        ];
        let cs = cluster_blind_files(&files);
        // getItem (consumes) and setItem (produces) share the receiver → ONE cluster. Clustering by METHOD
        // would split them, and a rep that teaches only one side grounds nothing: a key needs both.
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].signature, "recv:localStorage");
        assert_eq!(members(&cs[0], &files), vec!["r.ts", "w.ts"]);
    }

    #[test]
    fn a_this_chain_is_not_a_distinctive_signature() {
        let files = vec![
            f("x.ts", "class X { run() { return this.svc.repo.load(); } }"),
            f("y.ts", "class Y { go() { return this.api.client.fetch(); } }"),
        ];
        // Both are `this.*.*()`, on unrelated receivers. Merging them would have one rep's learned rule
        // claimed to ground the other's channel — an over-merge is a wrong answer, not just a lost one.
        assert_eq!(cluster_blind_files(&files).len(), 2);
    }

    #[test]
    fn a_single_file_is_one_cluster() {
        let files = vec![f("a.ts", "export async function a() { return prisma.eventType.findMany(); }")];
        let cs = cluster_blind_files(&files);
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].members.len(), 1);
    }

    #[test]
    fn the_shape_gate_marks_a_file_with_no_data_access_edge_unshaped() {
        let files = vec![
            f("store.ts", "export const read = () => localStorage.getItem('compactMode');\n"), // string-keyed call
            f("UserDto.ts", "export interface UserDto { id: string; name: string; roles: string[]; }\n"), // pure type
        ];
        let cs = cluster_blind_files(&files);
        let find = |name: &str| cs.iter().find(|c| c.members.iter().any(|&i| files[i].0 == name)).unwrap();
        assert!(find("store.ts").shaped, "a suspected edge is worth a pass");
        assert!(!find("UserDto.ts").shaped, "a DTO has nothing for the flywheel to learn — the infra flood");
    }

    // ── CROSS-LANGUAGE receiver extraction ───────────────────────────────────────────────────────────────
    // The clustering was once JS/TS-centric: it keyed off a `member_expression` callee, so Java's
    // `rs.getBytes()` (a `method_invocation` with an `object` field) and Ruby's `Payment.where()` (a `call`
    // with a `receiver`) had no receiver at all — every blind file became its own singleton, and 40 near-
    // identical Java serializers cost 40 model calls instead of one.
    #[test]
    fn java_serializers_sharing_a_receiver_collapse_to_one_rep() {
        let files: Vec<(String, String)> = (0..8)
            .map(|i| {
                f(
                    &format!("Ser{i}UserType.java"),
                    &format!("package m;\npublic class Ser{i}UserType {{\n  public Object get(java.sql.ResultSet rs, String[] n) {{ return rs.getBytes(n[0]); }}\n}}\n"),
                )
            })
            .collect();
        let cs = cluster_blind_files(&files);
        assert_eq!(by_sig(&cs, "recv:rs").map(|c| c.members.len()), Some(8), "8 files → 1 rep");
    }

    #[test]
    fn ruby_and_js_receivers_are_both_extracted() {
        let files = vec![
            f("report.rb", "class R\n def t\n  Payment.where(paid: true)\n end\nend\n"),
            f("a.ts", "export const f = (id: string) => prisma.booking.findUnique({ where: { id } });\n"),
            f("b.ts", "export const g = () => localStorage.getItem('k');\n"),
        ];
        let cs = cluster_blind_files(&files);
        assert!(by_sig(&cs, "recv:Payment").is_some(), "Ruby receiver");
        assert!(by_sig(&cs, "recv:prisma").is_some(), "JS deep chain");
        assert!(by_sig(&cs, "recv:localStorage").is_some(), "JS string-keyed");
    }
}
