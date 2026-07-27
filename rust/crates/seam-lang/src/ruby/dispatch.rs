//! RUBY QUALIFIED-CALL / METHOD RESOLUTION (deterministic floor) — resolves `recv.meth(...)` to the
//! method definition(s), the gap that blocks carrier-tracing (teacher 1) on Ruby. NO ruby-lsp: a
//! repo-wide tree-sitter index (classes/modules → superclass + mixins + methods) plus light scoped
//! receiver-type inference (`x = Foo.new` ⇒ `x : Foo`, `Foo.bar` ⇒ class Foo) plus an ancestor-chain
//! lookup (own → includes/prepends → superclass).
//!
//! Dispatch is over-approximated HONESTLY via a candidate set tiered by provenance — never a single
//! asserted guess. A PINNED receiver type with a unique chain hit → RESOLVED_FULL (the only tier a precise
//! call-graph consumer should assert); an unknown receiver → the method's defs repo-wide, RESOLVED_PARTIAL
//! (1) or SUGGESTED (N). Truly-dynamic dispatch (send/method_missing/define_method) is out of scope here
//! and stays an honest blindspot for the carrier-tracer to mark. The over-approximation is safe for the
//! sink-reaching goal (union the candidates) and quarantined from the precise graph by the tier.
//! Port of `languages/ruby/dispatch.ts`.

use crate::dispatch::{MethodCandidate, MethodDef, MethodIndex, MethodKind};
use crate::treesitter::Ctx;
use indexmap::IndexMap;
use std::collections::HashSet;
use tree_sitter::Node;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MixinMode {
    Include,
    Prepend,
    Extend,
}

#[derive(Clone, Debug)]
pub struct Mixin {
    pub name: String,
    pub mode: MixinMode,
}

#[derive(Clone, Debug)]
pub struct ClassInfo {
    pub fqn: String,
    pub file: String,
    pub line: usize,
    /// raw name as written (relative to the def's nesting)
    pub superclass: Option<String>,
    /// enclosing namespace parts at the def site (for relative const lookup)
    pub nesting: Vec<String>,
    pub mixins: Vec<Mixin>,
    /// method name → def (last definition wins on re-open)
    pub methods: IndexMap<String, MethodDef>,
}

/// The repo-wide Ruby class/module index, keyed by FQN. Insertion-ordered — `enclosing_class` and the
/// by-name over-approximation both walk it, and their output order is observable.
pub type RubyIndex = IndexMap<String, ClassInfo>;

/// One `x = Foo.new` / `@iv = Foo::Bar.new` style assignment — the receiver-type evidence.
#[derive(Clone, Debug)]
pub struct RubyAssign {
    pub name: String,
    pub fqn: String,
    pub line: usize,
}

const DYNAMIC: &[&str] = &["send", "__send__", "public_send"];
pub fn is_dynamic_dispatch(method: &str) -> bool {
    DYNAMIC.contains(&method)
}

/// Ruby top-level methods are private instance methods of Object — indexed under this synthetic FQN.
pub const TOPLEVEL: &str = "Object";

pub fn named_children<'a>(n: Node<'a>) -> Vec<Node<'a>> {
    (0..n.named_child_count()).filter_map(|i| n.named_child(i)).collect()
}

fn row(ctx: &Ctx, n: Node) -> usize {
    ctx.line_of(n.start_byte())
}

/// A constant reference node → its written name: `constant` ("VD") or `scope_resolution` ("Yuki::VD").
/// The carrier tracer reads constant receivers the same way (`Marshal.dump`). Port of `constName`.
pub fn const_name(ctx: &Ctx, n: Option<Node>) -> Option<String> {
    let n = n?;
    match n.kind() {
        "constant" => Some(ctx.text(n).to_string()),
        "scope_resolution" => {
            let scope = n.child_by_field_name("scope");
            let name = n.child_by_field_name("name");
            // an absent scope = a leading `::` (top-level)
            let s = scope.and_then(|s| const_name(ctx, Some(s))).unwrap_or_default();
            let nm = name.map(|x| ctx.text(x).to_string());
            if !s.is_empty() {
                Some(format!("{s}::{}", nm.unwrap_or_default()))
            } else {
                nm
            }
        }
        _ => None,
    }
}

/// `include`/`prepend`/`extend Foo` calls in a class body → mixins (the closed structural set).
fn mixin_of(ctx: &Ctx, call: Node) -> Option<Mixin> {
    if call.kind() != "call" || call.child_by_field_name("receiver").is_some() {
        return None; // only bare `include Foo`, no receiver
    }
    let mode = match ctx.text(call.child_by_field_name("method")?) {
        "include" => MixinMode::Include,
        "prepend" => MixinMode::Prepend,
        "extend" => MixinMode::Extend,
        _ => return None,
    };
    let args = call.child_by_field_name("arguments")?;
    let first = args.named_child(0);
    const_name(ctx, first).map(|name| Mixin { name, mode })
}

/// Walk one parsed Ruby file, merging classes/modules into the index (Ruby re-opens classes across files).
fn index_file(ctx: &Ctx, file: &str, index: &mut RubyIndex) {
    fn ensure<'i>(index: &'i mut RubyIndex, fqn: &str, nesting: &[String], file: &str, line: usize) -> &'i mut ClassInfo {
        index.entry(fqn.to_string()).or_insert_with(|| ClassInfo {
            fqn: fqn.to_string(),
            file: file.to_string(),
            line,
            superclass: None,
            nesting: nesting.to_vec(),
            mixins: Vec::new(),
            methods: IndexMap::new(),
        })
    }

    // `nesting` = the namespace parts CONTAINING the node (e.g. ["Yuki","VD"] inside class VD in module Yuki).
    fn visit(ctx: &Ctx, n: Node, nesting: &[String], file: &str, index: &mut RubyIndex) {
        if n.kind() == "class" || n.kind() == "module" {
            if let Some(name) = const_name(ctx, n.child_by_field_name("name")) {
                let mut inner: Vec<String> = nesting.to_vec();
                inner.push(name.clone());
                let fqn = inner.join("::");
                let r = row(ctx, n);
                let info = ensure(index, &fqn, nesting, file, r);
                if let Some(sc) = n.child_by_field_name("superclass") {
                    if info.superclass.is_none() {
                        let target = if sc.named_child_count() > 0 { sc.named_child(0) } else { Some(sc) };
                        if let Some(sc_name) = const_name(ctx, target) {
                            info.superclass = Some(sc_name);
                        }
                    }
                }
                for c in named_children(n) {
                    visit(ctx, c, &inner, file, index);
                }
                return;
            }
        }
        if n.kind() == "method" || n.kind() == "singleton_method" {
            if let Some(mn) = n.child_by_field_name("name").map(|x| ctx.text(x).to_string()) {
                let key = if nesting.is_empty() { TOPLEVEL.to_string() } else { nesting.join("::") };
                let outer: Vec<String> = if nesting.is_empty() { Vec::new() } else { nesting[..nesting.len() - 1].to_vec() };
                let r = row(ctx, n);
                let kind = if n.kind() == "singleton_method" { MethodKind::Class } else { MethodKind::Instance };
                ensure(index, &key, &outer, file, r).methods.insert(mn, MethodDef { kind, file: file.to_string(), line: r });
            }
            return; // don't index method-local nested defs
        }
        if n.kind() == "call" {
            if let Some(mx) = mixin_of(ctx, n) {
                let key = if nesting.is_empty() { TOPLEVEL.to_string() } else { nesting.join("::") };
                let outer: Vec<String> = if nesting.is_empty() { Vec::new() } else { nesting[..nesting.len() - 1].to_vec() };
                let r = row(ctx, n);
                let info = ensure(index, &key, &outer, file, r);
                if !info.mixins.iter().any(|e| e.name == mx.name && e.mode == mx.mode) {
                    info.mixins.push(mx);
                }
            }
        }
        for c in named_children(n) {
            visit(ctx, c, nesting, file, index);
        }
    }

    visit(ctx, ctx.root(), &[], file, index);
}

pub const EXTENSIONS: &[&str] = &[".rb", ".rake"];

/// Build the repo-wide Ruby class/method index (one parse per .rb file). Graceful: parse failures skip.
/// Port of `buildRubyIndex`.
pub fn build_ruby_index(repo: &str) -> RubyIndex {
    let mut index: RubyIndex = IndexMap::new();
    for rel in seam_fs::source_files(repo, |r| r.ends_with(".rb") || r.ends_with(".rake")) {
        let Ok(bytes) = std::fs::read(format!("{repo}/{rel}")) else { continue };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let Some(ctx) = Ctx::parse(&text, "ruby") else { continue };
        index_file(&ctx, &rel, &mut index);
    }
    index
}

/// Known stdlib FACTORIES that return their receiver type (so `@f = File.open(p)` ⇒ `@f : File`). A
/// closed, registry-sourced set — distinct from generic `Const.new` (where the type IS the receiver).
fn factory(recv: &str, method: &str) -> Option<&'static str> {
    match (recv, method) {
        ("File", "open") | ("File", "new") => Some("File"),
        ("IO", "open") | ("IO", "new") => Some("IO"),
        ("StringIO", "new") => Some("StringIO"),
        ("Tempfile", "new") | ("Tempfile", "open") => Some("Tempfile"),
        _ => None,
    }
}

/// Collect type-bearing assignments (`name = Const.new(...)` or a known factory) — the receiver-type
/// evidence for pinning a later `name.method(...)`. Locals + @ivars; cross-method ivars (assigned in
/// `initialize`, used elsewhere) are caught because the whole file's root is walked. Port of
/// `inferAssignments`.
pub fn infer_assignments(ctx: &Ctx) -> Vec<RubyAssign> {
    fn visit(ctx: &Ctx, n: Node, out: &mut Vec<RubyAssign>) {
        if n.kind() == "assignment" {
            let left = n.child_by_field_name("left");
            let right = n.child_by_field_name("right");
            if let (Some(left), Some(right)) = (left, right) {
                if right.kind() == "call" && (left.kind() == "identifier" || left.kind() == "instance_variable") {
                    let recv_const = const_name(ctx, right.child_by_field_name("receiver"));
                    let m = right.child_by_field_name("method").map(|x| ctx.text(x).to_string());
                    let fqn = match (m.as_deref(), recv_const.as_deref()) {
                        (Some("new"), _) => recv_const.clone(),
                        (Some(m), Some(rc)) => factory(rc, m).map(|s| s.to_string()),
                        _ => None,
                    };
                    if let Some(fqn) = fqn {
                        out.push(RubyAssign { name: ctx.text(left).to_string(), fqn, line: ctx.line_of(n.start_byte()) });
                    }
                }
            }
        }
        for c in named_children(n) {
            visit(ctx, c, out);
        }
    }
    let mut out = Vec::new();
    visit(ctx, ctx.root(), &mut out);
    out
}

/// Resolve a constant name written in a given nesting to an indexed FQN (lexical lookup: nesting outward,
/// then top-level). Returns the FQN key present in the index, or None.
fn resolve_const(index: &RubyIndex, name: &str, nesting: &[String]) -> Option<String> {
    for k in (0..=nesting.len()).rev() {
        let mut parts: Vec<&str> = nesting[..k].iter().map(|s| s.as_str()).collect();
        parts.push(name);
        let cand = parts.join("::");
        if index.contains_key(&cand) {
            return Some(cand);
        }
    }
    if index.contains_key(name) {
        Some(name.to_string())
    } else {
        None
    }
}

/// Ancestor-chain lookup: own methods → includes/prepends (instance) / extends (class) → superclass →
/// implicit Object, recursively. Approximate MRO (no exact prepend precedence — we union for the
/// sink-reaching goal). First hit wins, RESOLVED_FULL. Cycle-safe via `seen`, capped at 64 like the
/// generic walker it was factored out of. Dedup is by FQN ALONE (not FQN+kind), matching the TS
/// `keyOf` — a change here silently widens or narrows the chain.
fn lookup(index: &RubyIndex, fqn: &str, method: &str, kind: MethodKind, seen: &mut HashSet<String>) -> Option<MethodCandidate> {
    if seen.contains(fqn) || seen.len() > 64 {
        return None;
    }
    seen.insert(fqn.to_string());
    let info = index.get(fqn)?;
    if let Some(own) = info.methods.get(method) {
        if own.kind == kind {
            return Some(MethodCandidate {
                class_name: fqn.to_string(),
                method: method.to_string(),
                file: own.file.clone(),
                line: own.line,
                kind: own.kind,
                tier: "RESOLVED_FULL".to_string(),
            });
        }
    }
    // a mixed-in module's methods are INSTANCE methods of the module; look them up as instance regardless
    let modes: &[MixinMode] = if kind == MethodKind::Instance { &[MixinMode::Include, MixinMode::Prepend] } else { &[MixinMode::Extend] };
    let mut next: Vec<(String, MethodKind)> = Vec::new();
    for mx in &info.mixins {
        if !modes.contains(&mx.mode) {
            continue;
        }
        if let Some(mfqn) = resolve_const(index, &mx.name, &info.nesting) {
            next.push((mfqn, MethodKind::Instance));
        }
    }
    if let Some(sc) = &info.superclass {
        if let Some(sfqn) = resolve_const(index, sc, &info.nesting) {
            next.push((sfqn, kind));
        }
    }
    // implicit Object: every class without an explicit superclass inherits Object, whose (private) instance
    // methods are the repo's TOP-LEVEL `def`s — so a top-level helper called from inside a class resolves.
    if kind == MethodKind::Instance && info.superclass.is_none() && fqn != TOPLEVEL && fqn != "BasicObject" {
        next.push((TOPLEVEL.to_string(), MethodKind::Instance));
    }
    for (nf, nk) in next {
        if let Some(h) = lookup(index, &nf, method, nk, seen) {
            return Some(h);
        }
    }
    None
}

/// A receiver-less (self) call inside `class_name`'s body → its instance-method def via the ancestor chain.
pub fn resolve_self_call(index: &RubyIndex, class_name: &str, method: &str) -> Vec<MethodCandidate> {
    lookup(index, class_name, method, MethodKind::Instance, &mut HashSet::new()).into_iter().collect()
}

/// All defs of `method` across the index — the over-approximation used when the receiver type is unknown.
fn by_name(index: &RubyIndex, method: &str, tier: &str) -> Vec<MethodCandidate> {
    index
        .values()
        .filter_map(|info| {
            info.methods.get(method).map(|d| MethodCandidate {
                class_name: info.fqn.clone(),
                method: method.to_string(),
                file: d.file.clone(),
                line: d.line,
                kind: d.kind,
                tier: tier.to_string(),
            })
        })
        .collect()
}

/// Resolve `recvExpr.method(...)` at `at_line` to method-definition candidate(s), tiered by provenance.
///  - receiver is a Constant (`Foo` / `Foo::Bar`)  → class-method lookup on that type (PINNED) → RESOLVED_FULL
///  - receiver is a local/@ivar assigned `= C.new` → instance lookup on C (PINNED) → RESOLVED_FULL
///  - receiver type unknown                        → the method's defs repo-wide: 1 ⇒ RESOLVED_PARTIAL, N ⇒ SUGGESTED
pub fn resolve_method_call(index: &RubyIndex, recv_expr: &str, method: &str, assigns: &[RubyAssign], at_line: usize, nesting: &[String]) -> Vec<MethodCandidate> {
    let is_const = recv_expr.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false) || recv_expr.contains("::");
    if is_const {
        // PINNED via constant receiver → class-method call.
        if let Some(fqn) = resolve_const(index, recv_expr, nesting) {
            if let Some(hit) = lookup(index, &fqn, method, MethodKind::Class, &mut HashSet::new()) {
                return vec![hit];
            }
        }
    } else {
        // PINNED via the nearest preceding `recvExpr = Const.new` (last assignment before the call).
        let a = assigns.iter().filter(|x| x.name == recv_expr && x.line <= at_line).max_by_key(|x| x.line);
        if let Some(a) = a {
            if let Some(fqn) = resolve_const(index, &a.fqn, nesting) {
                if let Some(hit) = lookup(index, &fqn, method, MethodKind::Instance, &mut HashSet::new()) {
                    return vec![hit];
                }
            }
        }
    }
    // UNKNOWN receiver type → over-approximate by method name, tiered by candidate count (quarantined behind the tier).
    let mut all = by_name(index, method, "SUGGESTED");
    if all.len() == 1 {
        all[0].tier = "RESOLVED_PARTIAL".to_string();
    }
    all
}

impl MethodIndex for RubyIndex {
    fn method_def(&self, class_name: &str, method: &str) -> Option<MethodDef> {
        self.get(class_name)?.methods.get(method).cloned()
    }
    fn repo_method_names(&self) -> HashSet<String> {
        self.values().flat_map(|i| i.methods.keys().cloned()).collect()
    }
    fn enclosing_class(&self, file: &str, row: usize, fallback: Option<&str>) -> Option<String> {
        let mut best = fallback.map(|s| s.to_string());
        let mut span = usize::MAX;
        for (key, info) in self.iter() {
            for d in info.methods.values() {
                if d.file == file && d.line <= row && (row - d.line) < span {
                    best = Some(key.clone());
                    span = row - d.line;
                }
            }
        }
        best
    }
}
