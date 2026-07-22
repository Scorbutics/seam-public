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

fn class_methods(ctx: &Ctx, name: &str) -> Vec<(String, usize, usize)> {
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
}
