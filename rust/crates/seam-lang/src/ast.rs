//! Language-agnostic AST extractors over a `Ctx`, driven by the node-kind registry (port of the shared
//! helpers in ast_units.ts / ast_class.ts). These are the substrate the callsite graph is built on.

use serde::{Deserialize, Serialize};
use crate::node_kinds as nk;
use crate::treesitter::Ctx;
use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

/// A named code unit (function / method / class): (name, kind, start line, end line). Port of `Unit`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unit {
    pub name: String,
    pub kind: String,
    pub start: usize,
    pub end: usize,
}

/// A method call site with its resolved receiver — port of `_CallSite`. `recv_id` = a variable/field name
/// receiver (`x.m()` → x); `recv_new` = an instantiated-type receiver (`new T().m()` → T).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallSite {
    pub method: String,
    pub line: usize,
    pub recv_id: Option<String>,
    pub recv_new: Option<String>,
    /// The receiver NODE KIND verbatim, so a caller holding the FILE can ask the language registry whether it is
    /// the SELF receiver (`LanguageProvider::self_receiver`) — `this.m()` dispatches to the ENCLOSING class, a
    /// fact neither `recv_id` nor `recv_new` can express.
    pub recv_kind: String,
}

/// A declaration's declared name — the `name` field, then the C/C++ `declarator` chain, then a positional
/// name-kind child (port of `_name_of`). NOT a positional first child (which would grab a leading return type).
pub fn name_of(ctx: &Ctx, node: Node) -> Option<String> {
    if let Some(nf) = node.child_by_field_name("name") {
        return Some(ctx.text(nf).to_string());
    }
    let mut x = node.child_by_field_name("declarator");
    for _ in 0..16 {
        let Some(n) = x else { break };
        if nk::is_name_leaf(n.kind()) {
            return Some(ctx.text(n).to_string());
        }
        x = n.child_by_field_name("declarator");
    }
    ctx.children(node)
        .into_iter()
        .find(|c| nk::is_name_kind(c.kind()))
        .map(|c| ctx.text(c).to_string())
}

struct Callee<'a> {
    name: String,
    /// The NAME node itself — the call-site candidate's own position (a call's span starts at the receiver,
    /// so the method token has to be located separately). TS `_callee().nameNode`.
    name_node: Node<'a>,
    obj: Option<Node<'a>>,
}

/// A call's (method name, receiver). Reads the flat name FIELD first (Java/Ruby), else a nested member access,
/// else a bare identifier (an unqualified call, no receiver). Port of `_callee`.
fn callee<'a>(ctx: &Ctx, call: Node<'a>) -> Option<Callee<'a>> {
    for nf in nk::CALL_NAME_FIELD {
        if let Some(n) = call.child_by_field_name(nf) {
            let obj = nk::CALL_RECV_FIELD.iter().find_map(|of| call.child_by_field_name(of));
            return Some(Callee { name: ctx.text(n).to_string(), name_node: n, obj });
        }
    }
    let children = ctx.children(call);
    let fn_node = children.first().copied()?;
    if nk::is_member(fn_node.kind()) {
        let mch = ctx.children(fn_node);
        if let Some(&prop) = mch.iter().find(|c| nk::is_member_name(c.kind())) {
            return Some(Callee { name: ctx.text(prop).to_string(), name_node: prop, obj: mch.first().copied() });
        }
    }
    if nk::is_name_kind(fn_node.kind()) {
        return Some(Callee { name: ctx.text(fn_node).to_string(), name_node: fn_node, obj: None });
    }
    None
}

/// The distinct method names called ON A RECEIVER in this file (`x.m()` → `m`; a bare `f()` is excluded).
/// Insertion order = collect order (port of `_called_method_names`).
pub fn called_method_names(ctx: &Ctx) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for call in ctx.collect(ctx.root(), nk::is_call) {
        if let Some(c) = callee(ctx, call) {
            if c.obj.is_some() && seen.insert(c.name.clone()) {
                out.push(c.name);
            }
        }
    }
    out
}

/// One file's interface→impl contribution: the interface names it declares, the `(super, subtype)` implements/
/// interface-extends edges, and the zero-arg `(method, returnType)` provider accessors. Port of `_scanImplFile`
/// (the AST part; the marker pre-gate lives in the index build). Framework-agnostic — structural relations only.
pub struct ImplContribution {
    pub interfaces: Vec<String>,
    pub edges: Vec<(String, String)>,
    pub accessors: Vec<(String, String)>,
}

/// The BASE name of a type token — strip a generic arg list + package qualifier (`a.b.List<X>` → `List`).
/// Empty when the residue isn't a plain identifier. Port of `_baseTypeName`.
fn base_type_name(t: &str) -> String {
    let no_gen = t.split('<').next().unwrap_or(t).trim();
    let seg = no_gen.rsplit('.').next().unwrap_or(no_gen);
    if !seg.is_empty() && seg.chars().enumerate().all(|(i, c)| if i == 0 { c.is_ascii_alphabetic() || c == '_' || c == '$' } else { c.is_ascii_alphanumeric() || c == '_' || c == '$' }) {
        seg.to_string()
    } else {
        String::new()
    }
}

/// The base names of an `implements`/heritage clause on `node` — direct clause children, or nested under a TS
/// `class_heritage` wrapper (filtered to implements clauses). `pred` selects which clause kinds count.
/// The base names a heritage clause matching `pred` introduces on `node` — the extraction the interface
/// index, the class-bases scan and the `implements` reads all share. Public because the framework-entry
/// detector needs the same `implements` read on a single anchor file.
pub fn heritage_bases(ctx: &Ctx, node: Node, pred: fn(&str) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    for h in ctx.children(node) {
        if pred(h.kind()) {
            out.extend(ctx.collect(h, nk::is_base_name).into_iter().map(|n| ctx.text(n).to_string()));
        } else if h.kind() == "class_heritage" {
            for ec in ctx.children(h).into_iter().filter(|c| pred(c.kind())) {
                out.extend(ctx.collect(ec, nk::is_base_name).into_iter().map(|n| ctx.text(n).to_string()));
            }
        }
    }
    out
}

pub fn impl_contribution(ctx: &Ctx) -> ImplContribution {
    let mut interfaces = Vec::new();
    let mut edges: Vec<(String, String)> = Vec::new();
    // interfaces + interface-extends edges [super, sub]
    for itf in ctx.collect(ctx.root(), nk::is_interface) {
        let Some(nm) = name_of(ctx, itf) else { continue };
        interfaces.push(nm.clone());
        for sn in heritage_bases(ctx, itf, nk::is_heritage) {
            if !sn.is_empty() && sn != nm {
                edges.push((sn, nm.clone()));
            }
        }
    }
    // class implements edges [super, class]
    for cls in ctx.collect(ctx.root(), nk::is_class_kind) {
        let Some(cn) = name_of(ctx, cls) else { continue };
        for s in heritage_bases(ctx, cls, nk::is_implements) {
            edges.push((s, cn.clone()));
        }
    }
    // zero-arg provider accessors (method → return type name)
    let mut accessors: Vec<(String, String)> = Vec::new();
    for m in ctx.collect(ctx.root(), nk::is_method_kind) {
        let Some(nm) = name_of(ctx, m) else { continue };
        if let Some(params) = m.child_by_field_name("parameters") {
            if ctx.children(params).iter().any(|c| c.kind().contains("parameter")) {
                continue; // zero-arg only
            }
        }
        let Some(rt) = m.child_by_field_name("type") else { continue };
        let tn = base_type_name(ctx.text(rt));
        if !tn.is_empty() && tn != nm {
            accessors.push((nm, tn));
        }
    }
    ImplContribution { interfaces, edges, accessors }
}

/// Each class → its `extends` base names (port of `_class_bases`). The extends clause is a direct heritage
/// child, or nested one level under a TS `class_heritage` wrapper.
pub fn class_bases(ctx: &Ctx) -> Vec<(String, Vec<String>)> {
    let names_of = |clause: Node| -> Vec<String> {
        ctx.children(clause)
            .into_iter()
            .filter(|c| nk::is_base_name(c.kind()))
            .map(|c| ctx.text(c).to_string())
            .collect()
    };
    let mut out = Vec::new();
    for cls in ctx.collect(ctx.root(), nk::is_class_kind) {
        let Some(name) = name_of(ctx, cls) else { continue };
        let mut bases = Vec::new();
        for h in ctx.children(cls) {
            if nk::is_heritage(h.kind()) {
                bases.extend(names_of(h));
            } else if h.kind() == "class_heritage" {
                for ec in ctx.children(h).into_iter().filter(|c| nk::is_heritage(c.kind())) {
                    bases.extend(names_of(ec));
                }
            }
        }
        out.push((name, bases));
    }
    out
}

/// Every method call site (with a receiver) in the file, receiver-resolved. Port of `_all_call_sites`.
pub fn call_sites(ctx: &Ctx) -> Vec<CallSite> {
    let mut out = Vec::new();
    for call in ctx.collect(ctx.root(), nk::is_call) {
        let Some(c) = callee(ctx, call) else { continue };
        let Some(obj) = c.obj else { continue };
        let (mut recv_id, mut recv_new) = (None, None);
        let ok = obj.kind();
        if ok == "identifier" {
            recv_id = Some(ctx.text(obj).to_string());
        } else if nk::is_new(ok) {
            recv_new = ctx.children(obj).into_iter().find(|x| x.kind() == "identifier" || nk::is_member(x.kind())).map(|c| ctx.text(c).to_string());
        } else if nk::is_member(ok) {
            recv_id = ctx.children(obj).into_iter().find(|x| nk::is_member_name(x.kind())).map(|c| ctx.text(c).to_string());
        } else if nk::is_call(ok) {
            // Ruby `Const.new.method()` — the receiver is itself a `.new` call on a Constant.
            let mth = nk::CALL_NAME_FIELD.iter().find_map(|f| obj.child_by_field_name(f));
            let rcv = nk::CALL_RECV_FIELD.iter().find_map(|f| obj.child_by_field_name(f));
            if let (Some(m), Some(r)) = (mth, rcv) {
                if ctx.text(m) == "new" && ctx.text(r).chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                    recv_new = ctx.text(r).rsplit("::").next().map(String::from);
                }
            }
        }
        out.push(CallSite { method: c.name, line: ctx.span(call).0, recv_id, recv_new, recv_kind: ok.to_string() });
    }
    out
}

/// The type names the file DELEGATES to (call receivers' resolved types + unqualified callee names) — the
/// "called" set the down builder uses to tell a delegation `import` edge from a payload `type-ref`. Port of
/// `_called_types`.
pub fn called_types(ctx: &Ctx) -> HashSet<String> {
    let mut out = HashSet::new();
    let inst = instance_types(ctx);
    for call in ctx.collect(ctx.root(), nk::is_call) {
        let Some(c) = callee(ctx, call) else { continue };
        let Some(obj) = c.obj else {
            out.insert(c.name); // unqualified foo() → foo
            continue;
        };
        let ok = obj.kind();
        if ok == "identifier" {
            if let Some(ts) = inst.get(ctx.text(obj)) {
                out.extend(ts.iter().cloned());
            }
        } else if nk::is_new(ok) {
            if let Some(cons) = ctx.children(obj).into_iter().find(|x| x.kind() == "identifier" || nk::is_member(x.kind())) {
                out.insert(ctx.text(cons).to_string());
            }
        } else if nk::is_member(ok) {
            if let Some(ip) = ctx.children(obj).into_iter().find(|x| nk::is_member_name(x.kind())) {
                if let Some(ts) = inst.get(ctx.text(ip)) {
                    out.extend(ts.iter().cloned());
                }
            }
        }
    }
    out
}

/// Variable/field/param name → the declared/instantiated types bound to it. Port of `_instance_types`.
pub fn instance_types(ctx: &Ctx) -> HashMap<String, HashSet<String>> {
    let mut out: HashMap<String, HashSet<String>> = HashMap::new();
    for node in ctx.collect(ctx.root(), nk::is_instance_binder) {
        let Some(name_node) = ctx.children(node).into_iter().find(|c| nk::is_name_kind(c.kind())) else { continue };
        let mut types: HashSet<String> = binder_types(ctx, node).into_iter().collect();
        for nx in ctx.collect(node, nk::is_new) {
            if let Some(cons) = ctx.children(nx).into_iter().find(|x| x.kind() == "identifier" || nk::is_member(x.kind())) {
                types.insert(ctx.text(cons).to_string());
            }
        }
        if !types.is_empty() {
            out.entry(ctx.text(name_node).to_string()).or_default().extend(types);
        }
    }
    out
}

fn binder_types(ctx: &Ctx, binder: Node) -> Vec<String> {
    let mut out: Vec<String> = ctx.collect(binder, nk::is_type_ref).iter().map(|t| ctx.text(*t).to_string()).collect();
    if let Some(tf) = binder.parent().and_then(|p| p.child_by_field_name("type")) {
        if nk::is_type_ref(tf.kind()) {
            out.push(ctx.text(tf).to_string());
        } else {
            for t in ctx.collect(tf, nk::is_type_ref) {
                out.push(ctx.text(t).to_string());
            }
        }
    }
    out
}

/// Type tokens named in the file (references + instantiations). Port of `_type_names`.
pub fn type_names(ctx: &Ctx) -> HashSet<String> {
    let mut out = HashSet::new();
    for t in ctx.collect(ctx.root(), nk::is_type_ref) {
        out.insert(ctx.text(t).to_string());
    }
    for nx in ctx.collect(ctx.root(), nk::is_new) {
        if let Some(c) = ctx.children(nx).into_iter().find(|x| x.kind() == "identifier" || nk::is_member(x.kind())) {
            out.insert(ctx.text(c).to_string());
        }
    }
    out
}

/// The file's named units (functions/methods/classes), for attributing a call site to its enclosing unit.
/// Port of `_named_units`. A funclike directly in a class body is a "method" even if its kind isn't a method kind.
pub fn named_units(ctx: &Ctx) -> Vec<Unit> {
    let mut units = Vec::new();
    named_units_visit(ctx, ctx.root(), false, &mut units);
    units
}

fn named_units_visit(ctx: &Ctx, n: Node, in_class: bool, units: &mut Vec<Unit>) {
    let k = n.kind();
    if nk::is_funclike(k) && !nk::is_anon_func(k) {
        if let Some(name) = name_of(ctx, n) {
            let (s, e) = ctx.span(n);
            let kind = if nk::is_method_kind(k) || in_class { "method" } else { "function" };
            units.push(Unit { name, kind: kind.into(), start: s, end: e });
        }
    } else if nk::is_class_kind(k) {
        if let Some(name) = name_of(ctx, n) {
            let (s, e) = ctx.span(n);
            units.push(Unit { name, kind: "class".into(), start: s, end: e });
        }
    } else if nk::is_var_declarator(k) {
        let ch = ctx.children(n);
        if let Some(&fl) = ch.iter().find(|c| nk::is_funclike(c.kind())) {
            if ch.first().is_some_and(|c0| nk::is_name_kind(c0.kind())) {
                let (s, e) = ctx.span(fl);
                units.push(Unit { name: ctx.text(ch[0]).to_string(), kind: "function".into(), start: s, end: e });
            }
        }
    }
    let child_in_class = if nk::is_class_kind(k) { true } else if nk::is_funclike(k) { false } else { in_class };
    for c in ctx.children(n) {
        named_units_visit(ctx, c, child_in_class, units);
    }
}

/// The smallest-span unit containing `line` (port of `_enclosing`); ties keep the first.
pub fn enclosing(units: &[Unit], line: usize) -> Option<&Unit> {
    units.iter().filter(|u| u.start <= line && line <= u.end).min_by_key(|u| u.end - u.start)
}

/// The smallest CLASS unit strictly containing [start,end] — the owning class name, or "" (port of `_enclosingClass`).
pub fn enclosing_class(units: &[Unit], start: usize, end: usize) -> String {
    units
        .iter()
        .filter(|u| u.kind == "class" && u.start <= start && end <= u.end && !(u.start == start && u.end == end))
        .min_by_key(|u| u.end - u.start)
        .map(|u| u.name.clone())
        .unwrap_or_default()
}

/// The class that OWNS a FIELD-bound function member named `symbol` (`m = withReporting(this._m.bind(this))`).
/// Such a member is dispatched exactly like a method but is NOT a method_definition, so `named_units` yields no
/// unit and the call-site pass is left with an EMPTY owner — which turns off `family` / `provably_foreign` /
/// `provably_sibling` / `static_foreign` wholesale and degenerates the pass into a repo-wide NAME match.
/// Grounded on the parse tree (the field's span inside the class's span). Port of `_field_fn_owner`.
pub fn field_fn_owner(ctx: &Ctx, symbol: &str, units: &[Unit]) -> String {
    for f in ctx.collect(ctx.root(), crate::node_kinds::is_class_field) {
        if name_of(ctx, f).as_deref() != Some(symbol) {
            continue;
        }
        let (s, e) = ctx.span(f);
        let owner = enclosing_class(units, s, e);
        if !owner.is_empty() {
            return owner;
        }
    }
    String::new()
}

/// The method-precise index: the file's named units + a map of bare-callee name → the lines that call it
/// (a call node whose first child is an identifier). Feeds the grow's method-precise fan attribution. Port of
/// `methodPreciseIndex`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MpIndex {
    pub units: Vec<Unit>,
    pub calls: std::collections::HashMap<String, Vec<usize>>,
}

/// Build the method-precise index. Port of `methodPreciseIndex`.
pub fn method_precise_index(ctx: &Ctx) -> MpIndex {
    let units = named_units(ctx);
    let mut calls: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    for c in ctx.collect(ctx.root(), nk::is_call) {
        let ch = ctx.children(c);
        if let Some(first) = ch.first() {
            if first.kind().contains("identifier") {
                calls.entry(ctx.text(*first).to_string()).or_default().push(ctx.span(c).0);
            }
        }
    }
    MpIndex { units, calls }
}

/// The methods of the class/interface named `name` — (name, start, end), deduped. Port of `_type_methods`.
pub fn type_methods(ctx: &Ctx, name: &str) -> Vec<(String, usize, usize)> {
    let cm = class_methods(ctx, name);
    if !cm.is_empty() {
        return cm;
    }
    let Some(iface) = ctx.collect(ctx.root(), nk::is_interface).into_iter().find(|c| name_of(ctx, *c).as_deref() == Some(name)) else {
        return Vec::new();
    };
    dedup_methods(ctx.collect(iface, nk::is_interface_member).into_iter().filter_map(|m| name_of(ctx, m).map(|nm| (nm, ctx.span(m)))))
}

/// Is `node` a `new ClassName(...)` of exactly `class_name`? (port of `_is_new_of`).
fn is_new_of(ctx: &Ctx, node: Node, class_name: &str) -> bool {
    if !nk::is_new(node.kind()) {
        return false;
    }
    ctx.children(node)
        .into_iter()
        .find(|c| c.kind() == "identifier" || nk::is_member(c.kind()))
        .is_some_and(|c| ctx.text(c) == class_name)
}

/// The local names bound to an instance of `class_name` — typed (`C x` / `x: C`) or `= new C()`. Port of
/// `_instances_of`.
pub fn instances_of(ctx: &Ctx, class_name: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    for node in ctx.collect(ctx.root(), nk::is_instance_binder) {
        let Some(name_node) = ctx.children(node).into_iter().find(|c| nk::is_name_kind(c.kind())) else { continue };
        let typed = binder_types(ctx, node).iter().any(|t| t == class_name);
        let newed = ctx.collect(node, nk::is_new).into_iter().any(|nx| is_new_of(ctx, nx, class_name));
        if typed || newed {
            names.insert(ctx.text(name_node).to_string());
        }
    }
    names
}

/// The names `Object.prototype` exposes to a JS `key in {}` check (spec + Annex B, as JSC/bun report them).
/// TS's `_class_method_usage` guards insertion with `!(m in used)` on a bare `{}` object, so a method whose
/// name is one of these is NEVER recorded (the guard reads true from the empty object's prototype chain). We
/// reproduce that exactly for byte-identical parity — a `toString()`/`valueOf()` call is not attributed.
const JS_OBJECT_PROTO_PROPS: &[&str] = &[
    "toString", "valueOf", "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
    "toLocaleString", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
];

/// Is `name` a property `Object.prototype` exposes to a JS `key in {}` check? Several ports build a plain `{}`
/// object keyed by symbol/import names and guard insertion with `!(name in obj)`, so such names are silently
/// dropped — reproduce that for byte-identical parity.
pub fn is_js_object_proto_prop(name: &str) -> bool {
    JS_OBJECT_PROTO_PROPS.contains(&name)
}

/// `{method → first call line}` for methods of `class_name` called on a PROVABLE instance of it (an
/// instances_of local, a `new C()`, or a member of one). Port of `_class_method_usage`.
pub fn class_method_usage(ctx: &Ctx, class_name: &str, methods: &HashSet<String>) -> HashMap<String, usize> {
    let inst = instances_of(ctx, class_name);
    let mut used: HashMap<String, usize> = HashMap::new();
    for call in ctx.collect(ctx.root(), nk::is_call) {
        let Some(c) = callee(ctx, call) else { continue };
        let Some(obj) = c.obj else { continue };
        if !methods.contains(&c.name) {
            continue;
        }
        let ok = obj.kind();
        let hit = if ok == "identifier" {
            inst.contains(ctx.text(obj))
        } else if nk::is_new(ok) {
            is_new_of(ctx, obj, class_name)
        } else if nk::is_member(ok) {
            ctx.children(obj).into_iter().find(|x| nk::is_member_name(x.kind())).is_some_and(|ip| inst.contains(ctx.text(ip)))
        } else {
            false
        };
        // `!(m in used)`: skip when already recorded OR when the name is an Object.prototype property (the
        // JS quirk — see JS_OBJECT_PROTO_PROPS), so those method calls are never attributed.
        if hit && !JS_OBJECT_PROTO_PROPS.contains(&c.name.as_str()) {
            used.entry(c.name).or_insert_with(|| ctx.span(call).0);
        }
    }
    used
}

/// Lines where `local` is USED: call sites if any, else references inside a unit, else all-but-first
/// reference (drops the binding line). Port of `_usage_lines`.
pub fn usage_lines(ctx: &Ctx, units: &[Unit], local: &str) -> Vec<usize> {
    let calls = call_lines(ctx, local);
    if !calls.is_empty() {
        return calls;
    }
    let refs = ref_lines(ctx, local);
    let inside: Vec<usize> = refs.iter().copied().filter(|&ln| enclosing(units, ln).is_some()).collect();
    if !inside.is_empty() {
        inside
    } else {
        refs.into_iter().skip(1).collect()
    }
}

/// The span of a WRAPPED definition — `const X = wrap(realFn)` / `memo(() => {…})` — so an anchor bound to a
/// wrapper call still resolves to a real body span, not `[0,0]`. Returns the inline function's span, else the
/// named impl's span, else the declarator's. Port of `_wrappedDefSpan`.
pub fn wrapped_def_span(ctx: &Ctx, symbol: &str, units: &[Unit]) -> Option<(usize, usize)> {
    for d in ctx.collect(ctx.root(), nk::is_var_declarator) {
        let ch = ctx.children(d);
        if !ch.first().is_some_and(|c0| nk::is_name_kind(c0.kind()) && ctx.text(*c0) == symbol) {
            continue;
        }
        let Some(&call) = ch.iter().find(|c| nk::is_call(c.kind())) else { continue }; // `const X = <non-call>` — not a wrapped def
        return Some(match wrapped_impl(ctx, call, units, 0) {
            Some(Wrapped::Inline(n)) => ctx.span(n),                 // `memo(() => {…})` — the arrow IS the body
            Some(Wrapped::Named(i)) => (units[i].start, units[i].end), // `withReporting(_impl, …)` — the named impl
            None => ctx.span(d), // wrapped external fn → the declarator span (a real span, not :0)
        });
    }
    None
}

/// One observed CALL of a named symbol: where, and with how many arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallFact {
    pub name: String,
    pub line: usize,
    pub argc: usize,
    /// The name was the call's RECEIVER (`name.m(…)`), not its callee. A client object is USED at such a site
    /// without being invoked, and conflating the two makes an actively-used export read as dead.
    pub recv: bool,
}

/// The argument COUNT of a call node — named children of the argument list, so punctuation and comments do not
/// inflate it. A call whose argument list is unparseable counts 0, same as `f()`; the two are indistinguishable
/// here and neither is a claim about the callee's arity.
fn arg_count(ctx: &Ctx, call: Node) -> usize {
    let args = call
        .child_by_field_name("arguments")
        .or_else(|| ctx.children(call).into_iter().find(|c| c.kind().contains("arguments") || c.kind().contains("argument_list")));
    let Some(an) = args else { return 0 };
    (0..an.named_child_count()).filter_map(|i| an.named_child(i)).filter(|c| !c.kind().contains("comment")).count()
}

/// OBSERVED call facts for a set of names — every call site in this file whose callee is one of `names`, with
/// its argument count.
///
/// Includes BARE calls (`f(a, b)`), unlike `call_sites`, which requires a receiver: an imported function is
/// called bare, so a receiver-only scan sees none of the calls that matter to a module's contract.
///
/// NAME-GRAINED, deliberately: matching is by callee name, so a same-named local in the consuming file is
/// counted too. The contract shape declares that as a blindspot rather than resolving each site (which would
/// cost a full resolution pass per call), and the consuming file's own declarations are what let it detect
/// when the risk is real.
pub fn call_facts(ctx: &Ctx, names: &HashSet<String>) -> Vec<CallFact> {
    let mut out = Vec::new();
    for call in ctx.collect(ctx.root(), nk::is_call) {
        let Some(c) = callee(ctx, call) else { continue };
        let line = ctx.span(call).0;
        if names.contains(&c.name) {
            out.push(CallFact { name: c.name.clone(), line, argc: arg_count(ctx, call), recv: false });
        }
        // `name.m(…)` — the export is the RECEIVER. Recorded because an exported client object (`supabase.from
        // (…)`) is never itself called, and reporting that as "imported but never invoked" is simply false.
        if let Some(obj) = c.obj {
            if obj.kind() == "identifier" {
                let r = ctx.text(obj);
                if names.contains(r) {
                    out.push(CallFact { name: r.to_string(), line, argc: arg_count(ctx, call), recv: true });
                }
            }
        }
    }
    out
}

/// The DECLARED signature of a named function/method — its parameter list and return type AS WRITTEN, so a
/// consumer can see how to call it without reading the body. This is the half of a "contract" that a reader
/// otherwise has to open the file for.
///
/// Resolves a const-bound definition through `const_def_spans`, so `export const createBooking = withReporting(
/// _createBooking, …)` reports `_createBooking`'s signature rather than nothing — the wrapper is not what a
/// caller has to satisfy.
///
/// `None` when the name has no funclike declaration in this file (a class, a value export, an opaque wrapper
/// over an imported function). Absence is reported as absence; nothing is synthesised.
pub fn signature_of(ctx: &Ctx, name: &str, units: &[Unit]) -> Option<String> {
    // ONE LINE. A destructured parameter object is written across a dozen source lines, and a signature is a
    // label here, not a source excerpt — every consumer of this renders it inline.
    let flat = |s: &str| -> String { s.split_whitespace().collect::<Vec<_>>().join(" ") };
    let funclike = |n: Node| -> String {
        let params = n.child_by_field_name("parameters").map(|p| flat(ctx.text(p))).unwrap_or_else(|| "()".into());
        match n.child_by_field_name("return_type").or_else(|| n.child_by_field_name("type")) {
            // TS writes the return type as `: T` (the colon is part of the node); Java/Go put a bare type
            // elsewhere, so it is joined with an arrow to stay readable in one line.
            Some(t) => {
                let r = flat(ctx.text(t));
                if r.starts_with(':') {
                    format!("{params}{r}")
                } else {
                    format!("{params} -> {r}")
                }
            }
            None => params,
        }
    };
    let fns: Vec<Node> = ctx.collect(ctx.root(), |k| nk::is_funclike(k) || nk::is_method_kind(k));
    if let Some(&n) = fns.iter().find(|n| name_of(ctx, **n).as_deref() == Some(name)) {
        return Some(funclike(n));
    }
    // CONST-BOUND. Resolved from the declarator's own initializer, NOT by matching a span against
    // `const_def_spans`: that map falls back to the DECLARATOR span for a non-call initializer, and a
    // line-based match then picked up any function nested inside it — `export const supabase = { from: (t)
    // => … }` reported the signature `(t)`, which is the shape of an inner property, not of `supabase`.
    // A binding whose initializer is neither a funclike nor a wrapper call has no signature, and says so.
    let d = ctx.collect(ctx.root(), nk::is_var_declarator).into_iter().find(|d| {
        ctx.children(*d).first().is_some_and(|c0| nk::is_name_kind(c0.kind()) && ctx.text(*c0) == name)
    })?;
    let ch = ctx.children(d);
    if let Some(&f) = ch.iter().find(|c| nk::is_funclike(c.kind())) {
        return Some(funclike(f)); // `const f = (a, b) => …`
    }
    // `const f = withReporting(_impl, …)` — the caller must satisfy the IMPLEMENTATION, not the wrapper.
    let &call = ch.iter().find(|c| nk::is_call(c.kind()))?;
    match wrapped_impl(ctx, call, units, 0)? {
        Wrapped::Inline(n) => Some(funclike(n)),
        Wrapped::Named(i) => {
            let (s, e) = (units[i].start, units[i].end);
            fns.iter().find(|n| ctx.span(**n) == (s, e)).map(|&n| funclike(n))
        }
    }
}

/// EVERY top-level `const NAME = …` binding in the file, with the span of what it really names — bulk form of
/// `wrapped_def_span`, so a caller resolving MANY names pays one tree walk instead of one per name.
///
/// Wider than `wrapped_def_span` in one deliberate way: a NON-call initializer (`export const X = {…}`) is not a
/// "wrapped def" and that function rightly declines it, but it IS a real declaration at a real line, and a
/// caller asking "where does this imported name live?" needs an answer for it too. Those map to the declarator
/// span. Call initializers resolve through the shared `wrapped_impl` rule, so a wrapped export lands on the
/// IMPLEMENTATION (`export const createBooking = withReporting(_createBooking, …)` → `_createBooking`'s body)
/// rather than the wrapper line.
///
/// First declarator wins, matching `wrapped_def_span`'s first-match behaviour.
pub fn const_def_spans(ctx: &Ctx, units: &[Unit]) -> HashMap<String, (usize, usize)> {
    let mut out: HashMap<String, (usize, usize)> = HashMap::new();
    for d in ctx.collect(ctx.root(), nk::is_var_declarator) {
        let ch = ctx.children(d);
        let Some(&c0) = ch.first() else { continue };
        if !nk::is_name_kind(c0.kind()) {
            continue;
        }
        let name = ctx.text(c0).to_string();
        if out.contains_key(&name) {
            continue;
        }
        let span = match ch.iter().find(|c| nk::is_call(c.kind())) {
            Some(&call) => match wrapped_impl(ctx, call, units, 0) {
                Some(Wrapped::Inline(n)) => ctx.span(n),
                Some(Wrapped::Named(i)) => (units[i].start, units[i].end),
                None => ctx.span(d),
            },
            None => ctx.span(d),
        };
        out.insert(name, span);
    }
    out
}

/// Which argument of a wrapper CALL is the real implementation.
enum Wrapped<'t> {
    Inline(Node<'t>), // an inline funclike argument IS the body
    Named(usize),     // index into the `units` passed to `wrapped_impl` — the named impl
}

/// THE wrapper-unwrapping RULE, in one place: given a wrapper CALL node, which of its arguments is the real
/// implementation? An inline funclike argument IS the body (`memo(() => {…})`); otherwise the FIRST identifier
/// argument that names a function/method unit of this same file (`withReporting(_impl, "name")`). A nested
/// wrapper (`withReporting(withCache(fn))`) descends into the argument call. `None` = opaque (an externally
/// defined wrapped fn, an unnameable expression). Shared by `wrapped_def_span` and `default_export_local`, so
/// both read a wrapper the SAME way. Port of `_wrappedImpl`.
fn wrapped_impl<'t>(ctx: &Ctx, call: Node<'t>, units: &[Unit], depth: usize) -> Option<Wrapped<'t>> {
    if depth > 4 {
        return None; // runaway guard on `a(b(c(d(…))))`
    }
    let args_node = call
        .child_by_field_name("arguments")
        .or_else(|| ctx.children(call).into_iter().find(|c| c.kind().contains("arguments") || c.kind().contains("argument_list")));
    let args: Vec<Node> = match args_node {
        Some(an) => ctx.children(an),
        None => ctx.children(call).into_iter().skip(1).collect(),
    };
    if let Some(&inline) = args.iter().find(|a| nk::is_funclike(a.kind())) {
        return Some(Wrapped::Inline(inline));
    }
    for a in &args {
        if a.kind().contains("identifier") {
            if let Some(i) = units.iter().position(|x| x.name == ctx.text(*a) && (x.kind == "function" || x.kind == "method")) {
                return Some(Wrapped::Named(i));
            }
        }
    }
    for a in &args {
        if nk::is_call(a.kind()) {
            if let Some(inner) = wrapped_impl(ctx, *a, units, depth + 1) {
                return Some(inner);
            }
        }
    }
    None
}

/// The LOCAL symbol behind this file's `export default` — the missing piece of the most common addressing
/// mistake. Importers bind a default export under a name of THEIR choosing, so the name a caller sees at the
/// call sites is NOT a symbol of the defining file; the file's own name for it is. Structural: the `default`
/// keyword node marks the export, and the local is the exported declaration's name (`export default function
/// handler`), the exported identifier (`export default handler`), the local side of `export { handler as
/// default }`, or — for a HOC / reporting WRAPPER call (`export default withReporting(handler, "handler")`) —
/// the local behind it, via the SAME `wrapped_impl` rule as `wrapped_def_span`. Anonymous (`export default ()
/// => …`) → `None`: there is no local name to point at. Port of `_default_export_local`.
pub fn default_export_local(ctx: &Ctx, units: &[Unit]) -> Option<String> {
    for es in ctx.collect(ctx.root(), nk::is_export) {
        let kids = ctx.children(es);
        if !kids.iter().any(|c| nk::is_export_default(c.kind())) {
            // `export { handler as default }` — no `default` keyword on the statement; the specifier carries it.
            for cl in &kids {
                if !nk::is_export_clause(cl.kind()) {
                    continue;
                }
                for sp in ctx.children(*cl) {
                    if !nk::is_export_specifier(sp.kind()) {
                        continue;
                    }
                    let names: Vec<Node> = ctx.children(sp).into_iter().filter(|c| nk::is_name_kind(c.kind())).collect();
                    if names.len() >= 2 && ctx.text(names[names.len() - 1]) == "default" {
                        return Some(ctx.text(names[0]).to_string());
                    }
                }
            }
            continue;
        }
        for c in &kids {
            let k = c.kind();
            if nk::is_export_default(k) {
                continue;
            }
            if (nk::is_funclike(k) && !nk::is_anon_func(k)) || nk::is_class_kind(k) {
                if let Some(nm) = name_of(ctx, *c) {
                    return Some(nm);
                }
            } else if nk::is_name_kind(k) {
                return Some(ctx.text(*c).to_string());
            } else if nk::is_call(k) {
                // an inline arrow ⇒ anonymous, no local name to point at
                if let Some(Wrapped::Named(i)) = wrapped_impl(ctx, *c, units, 0) {
                    return Some(units[i].name.clone());
                }
            }
        }
    }
    None
}

/// Lines of a call whose callee LEADS with the identifier `local` (port of `_call_lines`).
/// Every use of a member on the ENCLOSING INSTANCE inside `[lo, hi]` → `(member, line)`. Three shapes, one
/// concept: the plain sibling call `this.m(...)`, the CALLBACK `f(this.m)`, and the BOUND reference
/// `f(this.m.bind(this))`. All three NAME a member of a KNOWN receiver (the enclosing class), so the caller can
/// resolve them against THAT class's declarations — never a repo-wide name match. Reading the REFERENCE (not the
/// call) is what catches the last two: `call_lines` only sees a bare-identifier callee, so a bound reference
/// passed as an ARGUMENT produced no signal at all.
/// The self-receiver node KIND is language-owned (`LanguageProvider::self_receiver`); a language declaring none
/// (Python — `self` is an ordinary parameter) yields `[]`, the conservative side. Both call grammars are covered:
/// the NESTED member form (TS/JS/C++) and the FLAT receiver/name-field form (Java/Ruby). Port of
/// `_self_member_refs`.
pub fn self_member_refs(ctx: &Ctx, file: &str, lo: usize, hi: usize) -> Vec<(String, usize)> {
    let selfk: &[&str] = crate::provider_for(file).map(|p| p.self_receiver()).unwrap_or(&[]);
    if selfk.is_empty() {
        return Vec::new();
    }
    let is_self = |k: &str| selfk.contains(&k);
    let mut out: Vec<(String, usize)> = Vec::new();
    let mut seen: HashSet<(String, usize)> = HashSet::new();
    let mut add = |member: String, line: usize, out: &mut Vec<(String, usize)>, seen: &mut HashSet<(String, usize)>| {
        if seen.insert((member.clone(), line)) {
            out.push((member, line));
        }
    };
    for m in ctx.collect(ctx.root(), nk::is_member) {
        let ln = ctx.span(m).0;
        if ln < lo || ln > hi {
            continue;
        }
        let ch = ctx.children(m);
        let Some(&first) = ch.first() else { continue };
        if !is_self(first.kind()) {
            continue;
        }
        if let Some(&prop) = ch.iter().find(|c| nk::is_member_name(c.kind()) || nk::is_name_kind(c.kind())) {
            if prop.id() != first.id() {
                add(ctx.text(prop).to_string(), ln, &mut out, &mut seen);
            }
        }
    }
    for c in ctx.collect(ctx.root(), nk::is_call) {
        let ln = ctx.span(c).0;
        if ln < lo || ln > hi {
            continue;
        }
        let recv = nk::CALL_RECV_FIELD.iter().find_map(|f| c.child_by_field_name(f));
        let nm = nk::CALL_NAME_FIELD.iter().find_map(|f| c.child_by_field_name(f));
        if let (Some(r), Some(n)) = (recv, nm) {
            if is_self(r.kind()) {
                add(ctx.text(n).to_string(), ln, &mut out, &mut seen);
            }
        }
    }
    out.sort_by_key(|x| x.1);
    out
}

pub fn call_lines(ctx: &Ctx, local: &str) -> Vec<usize> {
    let mut lines = Vec::new();
    for c in ctx.collect(ctx.root(), nk::is_call) {
        if let Some(&c0) = ctx.children(c).first() {
            if c0.kind().contains("identifier") && ctx.text(c0) == local {
                lines.push(ctx.span(c).0);
            }
        }
    }
    lines
}

/// The occurrences of `local`, split by whether the name is a MODULE-SCOPE binding use or a MEMBER access.
///  - `bare`      — a plain name reference (`f`, `f(…)`): whatever binds `f` in this file (a def, an import) IS
///                  what this occurrence means.
///  - `qualified` — the property side of a member access (`this.f`, `obj.f`): a member of some receiver, never
///                  the file's module-scope binding.
///
/// The distinction is what lets a caller drop a bare occurrence it can PROVE belongs to another binding while
/// keeping the member calls on the anchor's own class. Structural, off the member kind registry, never a literal
/// grammar kind — so it degrades to "everything is bare" on a grammar with no member node, the conservative
/// side. Port of `_ref_lines_split`.
pub fn ref_lines_split(ctx: &Ctx, local: &str) -> (Vec<usize>, Vec<usize>) {
    let (mut bare, mut qualified): (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
    for i in ctx.collect(ctx.root(), |k| k.contains("identifier")) {
        if ctx.text(i) != local {
            continue;
        }
        // grammars with no distinct property kind: a member access's FIRST child is the receiver, the rest is the property
        let is_prop = nk::is_member_name(i.kind())
            || i.parent().is_some_and(|p| nk::is_member(p.kind()) && ctx.children(p).first().is_some_and(|c0| c0.start_byte() != i.start_byte()));
        (if is_prop { &mut qualified } else { &mut bare }).push(ctx.span(i).0);
    }
    for v in [&mut bare, &mut qualified] {
        v.sort_unstable();
        v.dedup();
    }
    (bare, qualified)
}

/// Sorted unique lines of every identifier-kind node whose text is `local` (port of `_ref_lines`).
pub fn ref_lines(ctx: &Ctx, local: &str) -> Vec<usize> {
    let (bare, qualified) = ref_lines_split(ctx, local);
    let mut v: Vec<usize> = bare.into_iter().chain(qualified).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// A module's PUBLIC SURFACE — the exported members as units (deduped by name, first-wins). For an
/// export-statement language (TS/JS) it reads the `export` nodes; for an exportless one (Java/Ruby/C/C++) it
/// reads top-level type declarations + their members + free functions. Dispatched by the file's provider.
/// Port of `_exported_members`.
pub fn exported_members(ctx: &Ctx, file: &str) -> Vec<Unit> {
    if !crate::provider_for(file).map(|p| p.export_statements()).unwrap_or(false) {
        return public_surface(ctx);
    }
    let mut out: Vec<Unit> = Vec::new();
    for es in ctx.collect(ctx.root(), nk::is_export) {
        for ch in ctx.children(es) {
            let k = ch.kind();
            if nk::is_funclike(k) && !nk::is_anon_func(k) {
                if let Some(nm) = name_of(ctx, ch) {
                    let (s, e) = ctx.span(ch);
                    out.push(Unit { name: nm, kind: "function".into(), start: s, end: e });
                }
            } else if nk::is_class_kind(k) {
                if let Some(nm) = name_of(ctx, ch) {
                    let (s, e) = ctx.span(ch);
                    out.push(Unit { name: nm, kind: "class".into(), start: s, end: e });
                }
            } else if nk::is_var_decl(k) {
                for d in ctx.children(ch) {
                    if !nk::is_var_declarator(d.kind()) {
                        continue;
                    }
                    let dch = ctx.children(d);
                    if dch.first().is_some_and(|c0| nk::is_name_kind(c0.kind())) {
                        let is_fn = dch.iter().any(|c| nk::is_funclike(c.kind()));
                        let (s, e) = ctx.span(ch);
                        out.push(Unit { name: ctx.text(dch[0]).to_string(), kind: if is_fn { "function" } else { "constant" }.into(), start: s, end: e });
                    }
                }
            } else if nk::is_export_clause(k) {
                // `export { a, b }` / `export { a as b } from "./x"` — the exported NAME is the specifier's LAST
                // name identifier (the local alias is irrelevant at the boundary).
                for sp in ctx.children(ch) {
                    if !nk::is_export_specifier(sp.kind()) {
                        continue;
                    }
                    let names: Vec<Node> = ctx.children(sp).into_iter().filter(|c| nk::is_name_kind(c.kind())).collect();
                    if let Some(&last) = names.last() {
                        let (s, e) = ctx.span(sp);
                        out.push(Unit { name: ctx.text(last).to_string(), kind: "reference".into(), start: s, end: e });
                    }
                }
            }
        }
    }
    // THE DEFAULT SLOT IS PUBLIC SURFACE TOO. `export default handler` / `export default withReporting(handler,
    // "handler")` puts a declaration on the module boundary WITHOUT naming it in any declaration or specifier the
    // loop above reads — its child is a bare identifier or a CALL. So a module whose entire public API is its
    // default export reported ZERO exported members, hence `fan-in: 0 consuming files` for a module with real
    // importers. Grounded, not name-matched: the local must be a DECLARED unit of this file (that is where the
    // span comes from); an anonymous `export default () => …` or an opaque wrapper adds nothing. No double
    // count — a default whose local is ALSO a named export dedupes below. Port of fd61636.
    let dunits = named_units(ctx);
    if let Some(du) = default_export_local(ctx, &dunits).and_then(|d| dunits.iter().find(|u| u.name == d)) {
        out.push(du.clone());
    }
    dedup_units(out)
}

/// The public surface of an EXPORTLESS language: top-level type declarations + the members in their bodies +
/// top-level free functions (nested/local functions are not surface). Port of `_public_surface`.
fn public_surface(ctx: &Ctx) -> Vec<Unit> {
    let mut out: Vec<Unit> = Vec::new();
    public_surface_visit(ctx, ctx.root(), 0, &mut out);
    dedup_units(out)
}

fn public_surface_visit(ctx: &Ctx, n: Node, depth: usize, out: &mut Vec<Unit>) {
    let k = n.kind();
    if nk::is_class_kind(k) {
        if let Some(nm) = name_of(ctx, n) {
            let (s, e) = ctx.span(n);
            out.push(Unit { name: nm, kind: "class".into(), start: s, end: e });
        }
    } else if nk::is_funclike(k) && !nk::is_anon_func(k) {
        if let Some(nm) = name_of(ctx, n) {
            let (s, e) = ctx.span(n);
            let kind = if nk::is_method_kind(k) || depth > 0 { "method" } else { "function" };
            out.push(Unit { name: nm, kind: kind.into(), start: s, end: e });
        }
        return; // a function body holds locals, not surface
    }
    let child_depth = if nk::is_class_kind(k) { depth + 1 } else { depth };
    for c in ctx.children(n) {
        public_surface_visit(ctx, c, child_depth, out);
    }
}

fn dedup_units(units: Vec<Unit>) -> Vec<Unit> {
    let mut seen = HashSet::new();
    units.into_iter().filter(|u| seen.insert(u.name.clone())).collect()
}

/// The FIELD-BOUND function members of a class node — `m = (x) => …`, `m = withReporting(this._m.bind(this))`.
/// Dispatched exactly like a method (`instance.m()`) but no `is_method_kind` node, so `class_methods` never
/// listed it: a CLASS anchor's call-site pass had no such method NAME to hunt, and every consumer reaching the
/// class ONLY through that member was invisible to the whole UP direction. GROUNDED, never a name guess — the
/// field counts only when its own value subtree PROVES it holds a callable: it contains a function-like node,
/// or it NAMES one of the class's OWN declared methods (`this._m.bind(this)`, at any wrapper depth). A data
/// field (`limit = 5`, `repo = new Repo()`, no initializer) proves neither. Port of `_field_fn_members`.
fn field_fn_members(ctx: &Ctx, cls: Node, method_names: &HashSet<String>) -> Vec<(String, (usize, usize))> {
    let mut out = Vec::new();
    for f in ctx.collect(cls, nk::is_class_field) {
        let Some(nm) = name_of(ctx, f) else { continue };
        if method_names.contains(&nm) {
            continue;
        }
        let Some(val) = f.child_by_field_name("value") else { continue }; // no initializer → nothing proves callability
        let callable = !ctx.collect(val, nk::is_funclike).is_empty()
            || ctx
                .collect(val, |k| nk::is_member_name(k) || nk::is_name_kind(k))
                .into_iter()
                .any(|n| method_names.contains(ctx.text(n)));
        if callable {
            out.push((nm, ctx.span(f)));
        }
    }
    out
}

/// The methods of the class named `name` — (name, start, end), constructor excluded, deduped. Includes the
/// FIELD-BOUND function members (see `field_fn_members`): they are dispatched as methods, so a consumer scan
/// that omits them under-reports the class's callers. Port of `_class_methods`.
pub fn class_methods(ctx: &Ctx, name: &str) -> Vec<(String, usize, usize)> {
    let Some(cls) = ctx.collect(ctx.root(), nk::is_class_kind).into_iter().find(|c| name_of(ctx, *c).as_deref() == Some(name)) else {
        return Vec::new();
    };
    let declared: Vec<(String, (usize, usize))> = ctx
        .collect(cls, |k| nk::is_method_kind(k) && k != "constructor_declaration")
        .into_iter()
        .filter_map(|m| name_of(ctx, m).filter(|nm| nm != "constructor").map(|nm| (nm, ctx.span(m))))
        .collect();
    let names: HashSet<String> = declared.iter().map(|(n, _)| n.clone()).collect();
    let fields = field_fn_members(ctx, cls, &names);
    dedup_methods(declared.into_iter().chain(fields))
}

fn dedup_methods(it: impl Iterator<Item = (String, (usize, usize))>) -> Vec<(String, usize, usize)> {
    let mut seen = HashSet::new();
    it.filter(|(nm, _)| seen.insert(nm.clone())).map(|(nm, (s, e))| (nm, s, e)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_calls_and_bases() {
        let src = "class Foo extends Bar implements Baz {\n  void run(Thing t) {\n    t.doIt();\n    helper();\n    this.self();\n  }\n}\n";
        let ctx = Ctx::parse(src, "java").expect("java grammar");
        // only calls WITH a receiver: t.doIt(), this.self(); the bare helper() is excluded.
        let calls = called_method_names(&ctx);
        assert!(calls.contains(&"doIt".to_string()));
        assert!(calls.contains(&"self".to_string()));
        assert!(!calls.contains(&"helper".to_string()));
        // extends bases only (implements excluded)
        let bases = class_bases(&ctx);
        assert_eq!(bases, vec![("Foo".to_string(), vec!["Bar".to_string()])]);
    }

    #[test]
    fn java_call_sites_and_units() {
        let src = "class Foo {\n  void run() {\n    Bar b = new Bar();\n    b.go();\n    helper();\n  }\n}\n";
        let ctx = Ctx::parse(src, "java").unwrap();
        let sites: Vec<(String, Option<String>)> = call_sites(&ctx).into_iter().map(|s| (s.method, s.recv_id)).collect();
        // b.go() → recv_id=b (identifier receiver) ; helper() has no receiver → excluded.
        assert!(sites.contains(&("go".into(), Some("b".into()))));
        assert!(!sites.iter().any(|s| s.0 == "helper"));
        // b : Bar (declared) + Bar (new)
        let insts = instance_types(&ctx);
        let bar = HashSet::from(["Bar".to_string()]);
        assert_eq!(insts.get("b"), Some(&bar));
        // units: the class + the method
        let nu = named_units(&ctx);
        let units: Vec<(&str, &str)> = nu.iter().map(|u| (u.name.as_str(), u.kind.as_str())).collect();
        assert!(units.contains(&("Foo", "class")));
        assert!(units.contains(&("run", "method")));
    }

    #[test]
    fn class_method_usage_skips_object_proto_names() {
        // A call to a method named after an Object.prototype property (`toString`/`getX`) on a provable
        // instance: TS's `!(m in used)` guard on a bare `{}` skips `toString` (proto chain) but records
        // `getX`. We reproduce that exactly (see JS_OBJECT_PROTO_PROPS).
        let src = "class C {\n  void use() {\n    Widget w = new Widget();\n    w.toString();\n    w.getX();\n  }\n}\n";
        let ctx = Ctx::parse(src, "java").unwrap();
        let methods = HashSet::from(["toString".to_string(), "getX".to_string()]);
        let usage = class_method_usage(&ctx, "Widget", &methods);
        assert!(!usage.contains_key("toString"), "toString must be skipped (Object.prototype quirk)");
        assert!(usage.contains_key("getX"), "getX must be recorded");
    }
}

/// Binder name → the UNQUALIFIED callee its value is bound from (`const svc = getThingService();` →
/// `svc → getThingService`), or `None` when the same name is bound from two different callees (ambiguous).
/// A binder bound from anything that is not a bare `f()` call is absent. Port of `_call_bound_binders`.
pub fn call_bound_binders(ctx: &Ctx) -> HashMap<String, Option<String>> {
    let mut out: HashMap<String, Option<String>> = HashMap::new();
    for node in ctx.collect(ctx.root(), nk::is_instance_binder) {
        let ch = ctx.children(node);
        let Some(name_node) = ch.iter().copied().find(|c| nk::is_name_kind(c.kind())) else { continue };
        let name = ctx.text(name_node).to_string();
        let mut value = ch.iter().copied().filter(|c| c.id() != name_node.id()).next_back();
        // unwrap `await f()` / `(f())` / `f()!` / `f() as T` down to the call itself
        while let Some(v) = value {
            if !nk::is_call_value_unwrap(v.kind()) {
                break;
            }
            value = v.named_child(0);
        }
        let bound = value
            .filter(|v| nk::is_call(v.kind()))
            .and_then(|v| callee(ctx, v))
            .and_then(|c| c.obj.is_none().then_some(c.name));
        let Some(bound) = bound else { continue };
        match out.get(&name) {
            Some(prev) if prev.as_deref() != Some(bound.as_str()) => {
                out.insert(name, None);
            }
            Some(_) => {}
            None => {
                out.insert(name, Some(bound));
            }
        }
    }
    out
}

/// The single DECLARED return-type name of the function-like named `fn_name`, or `None` when it has none or
/// is not a LONE type reference (`Promise<T>` / a union / a generic — ambiguous, so we refuse to narrow).
/// Port of `_declared_return_type`.
pub fn declared_return_type(ctx: &Ctx, fn_name: &str) -> Option<String> {
    let lone = |rt: Node| -> Option<String> {
        let names: HashSet<String> = if nk::is_type_ref(rt.kind()) {
            std::iter::once(ctx.text(rt).to_string()).collect()
        } else {
            ctx.collect(rt, nk::is_type_ref).into_iter().map(|t| ctx.text(t).to_string()).collect()
        };
        (names.len() == 1).then(|| names.into_iter().next().unwrap())
    };
    for f in ctx.collect(ctx.root(), nk::is_funclike) {
        if name_of(ctx, f).as_deref() != Some(fn_name) {
            continue;
        }
        for field in nk::RETURN_TYPE_FIELD {
            if let Some(t) = f.child_by_field_name(field).and_then(lone) {
                return Some(t);
            }
        }
    }
    // `export const f = (): T => …` — the funclike is the declarator's VALUE, so it carries no name of its own.
    for d in ctx.collect(ctx.root(), nk::is_var_declarator) {
        let ch = ctx.children(d);
        let Some(first) = ch.first().copied() else { continue };
        if !nk::is_name_kind(first.kind()) || ctx.text(first) != fn_name {
            continue;
        }
        let Some(fl) = ch.iter().copied().find(|c| nk::is_funclike(c.kind())) else { continue };
        for field in nk::RETURN_TYPE_FIELD {
            if let Some(t) = fl.child_by_field_name(field).and_then(lone) {
                return Some(t);
            }
        }
    }
    None
}

/// Does the CONCRETE class named `type_name` (never an interface) DECLARE the method `method` itself?
/// Port of `_class_owns_method`.
pub fn class_owns_method(ctx: &Ctx, type_name: &str, method: &str) -> bool {
    let cls = ctx
        .collect(ctx.root(), |k| nk::is_class_kind(k) && !nk::is_interface(k))
        .into_iter()
        .find(|c| name_of(ctx, *c).as_deref() == Some(type_name));
    cls.is_some() && class_methods(ctx, type_name).iter().any(|m| m.0 == method)
}

/// Every name this file BINDS — named units, exported members, and any node carrying a `name` field or a
/// declarator/export-specifier identifier. Port of `_declared_names`.
///
/// It answers one question the engine cannot afford to get wrong: is the symbol a caller addressed actually
/// DECLARED here? A footprint builder that cannot find the symbol falls back to a bare node and asks who
/// imports THAT name FROM THIS FILE; nobody does, and the answer renders as an authoritative "nothing calls
/// this" — telling someone their live code is dead. The common trigger is routine: a DEFAULT export is bound
/// by importers under a name of their own choosing, so the name at every call site is not a symbol of the
/// defining file at all.
pub fn declared_names(ctx: &Ctx, file: Option<&str>) -> std::collections::HashSet<String> {
    let mut out: std::collections::HashSet<String> = std::collections::HashSet::new();
    for u in named_units(ctx) {
        out.insert(u.name);
    }
    for m in exported_members(ctx, file.unwrap_or("")) {
        out.insert(m.name);
    }
    for n in ctx.collect(ctx.root(), |_| true) {
        let k = n.kind();
        if !crate::node_kinds::is_call(k) {
            if let Some(nf) = n.child_by_field_name("name") {
                let nk = nf.kind();
                if crate::node_kinds::is_name_kind(nk) || crate::node_kinds::is_name_leaf(nk) {
                    out.insert(ctx.text(nf).to_string());
                }
            }
        }
        if crate::node_kinds::is_var_declarator(k) {
            let ch = ctx.children(n);
            if ch.first().is_some_and(|c| crate::node_kinds::is_name_kind(c.kind())) {
                out.insert(ctx.text(ch[0]).to_string());
            }
        }
        if crate::node_kinds::is_export_specifier(k) {
            for c in ctx.children(n) {
                if crate::node_kinds::is_name_kind(c.kind()) {
                    out.insert(ctx.text(c).to_string());
                }
            }
        }
    }
    // the `default` in `export { x as default }` is the BOUNDARY name, not a declared symbol
    out.remove("default");
    out
}

/// Every call site of one of `methods` (RECEIVER-AGNOSTIC — the name is enough) → (method, line, col). The
/// LSP-candidate input: the extension resolves each of these against a language server, then hands the
/// verified subset back as the class anchor's attribution. Port of `_class_call_sites`.
pub fn class_call_sites(ctx: &Ctx, methods: &std::collections::HashSet<String>) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    for call in ctx.collect(ctx.root(), nk::is_call) {
        if let Some(c) = callee(ctx, call) {
            if methods.contains(&c.name) {
                out.push((c.name, ctx.span(c.name_node).0, ctx.col(c.name_node.start_byte())));
            }
        }
    }
    out
}
