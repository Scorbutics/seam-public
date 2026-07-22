//! Language-agnostic AST extractors over a `Ctx`, driven by the node-kind registry (port of the shared
//! helpers in ast_units.ts / ast_class.ts). These are the substrate the callsite graph is built on.

use crate::node_kinds as nk;
use crate::treesitter::Ctx;
use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

/// A named code unit (function / method / class): (name, kind, start line, end line). Port of `Unit`.
#[derive(Clone, Debug, PartialEq, Eq)]
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
    obj: Option<Node<'a>>,
}

/// A call's (method name, receiver). Reads the flat name FIELD first (Java/Ruby), else a nested member access,
/// else a bare identifier (an unqualified call, no receiver). Port of `_callee`.
fn callee<'a>(ctx: &Ctx, call: Node<'a>) -> Option<Callee<'a>> {
    for nf in nk::CALL_NAME_FIELD {
        if let Some(n) = call.child_by_field_name(nf) {
            let obj = nk::CALL_RECV_FIELD.iter().find_map(|of| call.child_by_field_name(of));
            return Some(Callee { name: ctx.text(n).to_string(), obj });
        }
    }
    let children = ctx.children(call);
    let fn_node = children.first().copied()?;
    if nk::is_member(fn_node.kind()) {
        let mch = ctx.children(fn_node);
        if let Some(&prop) = mch.iter().find(|c| nk::is_member_name(c.kind())) {
            return Some(Callee { name: ctx.text(prop).to_string(), obj: mch.first().copied() });
        }
    }
    if nk::is_name_kind(fn_node.kind()) {
        return Some(Callee { name: ctx.text(fn_node).to_string(), obj: None });
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
fn heritage_bases(ctx: &Ctx, node: Node, pred: fn(&str) -> bool) -> Vec<String> {
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
        out.push(CallSite { method: c.name, line: ctx.span(call).0, recv_id, recv_new });
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
        let Some(&call) = ch.iter().find(|c| nk::is_call(c.kind())) else { continue };
        let args_node = call
            .child_by_field_name("arguments")
            .or_else(|| ctx.children(call).into_iter().find(|c| c.kind().contains("arguments") || c.kind().contains("argument_list")));
        let args: Vec<Node> = match args_node {
            Some(an) => ctx.children(an),
            None => ctx.children(call).into_iter().skip(1).collect(),
        };
        if let Some(&inline) = args.iter().find(|a| nk::is_funclike(a.kind())) {
            return Some(ctx.span(inline)); // `memo(() => {…})` — the arrow IS the body
        }
        for a in &args {
            if a.kind().contains("identifier") {
                if let Some(u) = units.iter().find(|x| x.name == ctx.text(*a) && (x.kind == "function" || x.kind == "method")) {
                    return Some((u.start, u.end)); // `withReporting(_impl, …)` — the named impl
                }
            }
        }
        return Some(ctx.span(d)); // wrapped external fn → the declarator span (a real span, not :0)
    }
    None
}

/// Lines of a call whose callee LEADS with the identifier `local` (port of `_call_lines`).
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

/// Sorted unique lines of every identifier-kind node whose text is `local` (port of `_ref_lines`).
pub fn ref_lines(ctx: &Ctx, local: &str) -> Vec<usize> {
    let mut v: Vec<usize> = ctx
        .collect(ctx.root(), |k| k.contains("identifier"))
        .into_iter()
        .filter(|i| ctx.text(*i) == local)
        .map(|i| ctx.span(i).0)
        .collect();
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

/// The methods of the class named `name` — (name, start, end), constructor excluded, deduped. Port of
/// `_class_methods`.
pub fn class_methods(ctx: &Ctx, name: &str) -> Vec<(String, usize, usize)> {
    let Some(cls) = ctx.collect(ctx.root(), nk::is_class_kind).into_iter().find(|c| name_of(ctx, *c).as_deref() == Some(name)) else {
        return Vec::new();
    };
    dedup_methods(
        ctx.collect(cls, |k| nk::is_method_kind(k) && k != "constructor_declaration")
            .into_iter()
            .filter_map(|m| name_of(ctx, m).filter(|nm| nm != "constructor").map(|nm| (nm, ctx.span(m)))),
    )
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
