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
    let gate = std::env::var("SEAM_COUPLING_SHAPE_GATE").as_deref() != Ok("0");
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
