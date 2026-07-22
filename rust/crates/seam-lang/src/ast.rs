//! Language-agnostic AST extractors over a `Ctx`, driven by the node-kind registry (port of the shared
//! helpers in ast_units.ts / ast_class.ts). These are the substrate the callsite graph is built on.

use crate::node_kinds as nk;
use crate::treesitter::Ctx;
use std::collections::HashSet;
use tree_sitter::Node;

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
}
