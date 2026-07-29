//! TS/ioctopus DI BINDING RESOLUTION — port of `ts/src/languages/typescript/di_bindings.ts`.
//!
//! The dependency graph already resolves interface->impl edges structurally. What it cannot see is WHICH
//! impl a runtime DI container BINDS to a token, and under what CONDITION. This recovers exactly that, so a
//! `--query dependencies` answer can say "ICache -> RealCache when (CACHE_URL) else NoopCache, bound @
//! cacheModule.ts:6" in one call instead of forcing the caller into follow-up greps.
//!
//! STRUCTURAL, not semantic: the ioctopus binding forms are a CLOSED grammar (bind/toClass/toFactory/toValue
//! plus the type-safe `bindModuleToClassOnToken` helper). We walk the tree-sitter AST and read the
//! literally-written impl class names and token — never a name guess, never a comment/string false-match.
//!
//! Kept in seam-lang, next to the other language grammars, mirroring the TypeScript's layering: the grammar
//! stays free of repo-scanning concerns and the walk/cache that feeds it lives in seam-scan::di_index.
use crate::treesitter::Ctx;
use serde::{Deserialize, Serialize};

use tree_sitter::Node;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DiBinding {
    /// bare token name, e.g. "REDIS_CLIENT"
    pub token: String,
    /// "toClass" | "toFactory" | "toValue"
    pub kind: String,
    /// concrete class name(s) the binding produces (a factory may yield more than one)
    pub impls: Vec<String>,
    /// the toFactory branch condition (raw), when it selects between impls
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    /// toClass ctor dep map: ctorKey -> bare DEP_TOKEN. INSERTION-ORDERED, not sorted and not a HashMap:
    /// this crosses to JS as an object, so its key order is observable. The order is the AST walk's —
    /// `collect` is a stack DFS, so it yields an object literal's pairs in REVERSE source order, and the
    /// TypeScript does the same. Sorting them (the tidy-looking choice) diverges: measured, `{db, other}`
    /// in source comes back `{other, db}` from both engines, and a BTreeMap re-sorted it to `{db, other}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deps: Option<indexmap::IndexMap<String, String>>,
    pub file: String,
    /// 1-based
    pub line: usize,
}

/// Textual pre-gate: a file with none of the ioctopus binding tokens cannot contribute, so the parse is
/// skipped. SOUND — every binding form contains one of these literally.
pub const DI_MARKERS: &[&str] = &[".bind(", "bindModuleToClassOnToken"];

pub fn bare(t: &str) -> String {
    let last = t.rsplit('.').next().unwrap_or(t);
    last.chars().filter(|c| !matches!(c, '"' | '\'' | '[' | ']')).collect::<String>().trim().to_string()
}

fn strip_parens(s: &str) -> String {
    let s = s.strip_prefix('(').unwrap_or(s);
    let s = s.strip_suffix(')').unwrap_or(s);
    s.trim().to_string()
}

fn field<'a>(n: Node<'a>, name: &str) -> Option<Node<'a>> {
    n.child_by_field_name(name)
}

/// The i-th NAMED argument of a call, or None.
fn arg_at<'a>(ctx: &Ctx, call: Node<'a>, i: usize) -> Option<Node<'a>> {
    let args = field(call, "arguments")?;
    let _ = ctx;
    if i < args.named_child_count() { args.named_child(i) } else { None }
}

fn row_of(n: Node) -> usize {
    n.start_position().row + 1
}

struct MemberCall<'a> {
    method: String,
    object: Option<Node<'a>>,
}

/// A call whose function is `<object>.<method>(...)`.
fn member_call<'a>(ctx: &Ctx, call: Node<'a>) -> Option<MemberCall<'a>> {
    let f = field(call, "function")?;
    if f.kind() != "member_expression" {
        return None;
    }
    let prop = field(f, "property")?;
    Some(MemberCall { method: ctx.text(prop).to_string(), object: field(f, "object") })
}

pub fn scan_di_bindings(rel: &str, ctx: &Ctx) -> Vec<DiBinding> {
    let mut bindings: Vec<DiBinding> = Vec::new();

    // local token aliases: `const token = DI_TOKENS.REDIS_CLIENT;` -> token -> "DI_TOKENS.REDIS_CLIENT"
    let mut alias: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for vd in ctx.collect(ctx.root(), |k| k == "variable_declarator") {
        let (Some(nm), Some(val)) = (field(vd, "name"), field(vd, "value")) else { continue };
        if nm.kind() == "identifier" && val.kind() == "member_expression" {
            alias.insert(ctx.text(nm).to_string(), ctx.text(val).to_string());
        }
    }
    let resolve_tok = |raw: &str| bare(alias.get(raw).map(String::as_str).unwrap_or(raw));

    for call in ctx.collect(ctx.root(), |k| k == "call_expression") {
        // FORM 1: X.bind(TOKEN).toClass/toFactory/toValue(...)
        if let Some(mc) = member_call(ctx, call) {
            let is_bind_tail = matches!(mc.method.as_str(), "toClass" | "toFactory" | "toValue");
            if is_bind_tail && mc.object.map(|o| o.kind()) == Some("call_expression") {
                let obj = mc.object.unwrap();
                let Some(inner) = member_call(ctx, obj) else { continue };
                if inner.method != "bind" {
                    continue;
                }
                let Some(tok_node) = arg_at(ctx, obj, 0) else { continue };
                let token = resolve_tok(ctx.text(tok_node));
                let line = row_of(call);

                if mc.method == "toClass" {
                    let cls_node = arg_at(ctx, call, 0);
                    let cls = match cls_node {
                        Some(n) if n.kind() == "identifier" => ctx.text(n).to_string(),
                        _ => "?".to_string(),
                    };
                    let mut deps: indexmap::IndexMap<String, String> = indexmap::IndexMap::new();
                    if let Some(dep_node) = arg_at(ctx, call, 1) {
                        if dep_node.kind() == "object" {
                            for p in ctx.collect(dep_node, |k| k == "pair") {
                                if let (Some(k), Some(v)) = (field(p, "key"), field(p, "value")) {
                                    deps.insert(bare(ctx.text(k)), bare(ctx.text(v)));
                                }
                            }
                        }
                    }
                    bindings.push(DiBinding {
                        token, kind: "toClass".into(), impls: vec![cls],
                        condition: None, deps: Some(deps), file: rel.to_string(), line,
                    });
                } else if mc.method == "toFactory" {
                    let body = arg_at(ctx, call, 0);
                    // SOURCE-ORDER matters: the FIRST `new X()` is the condition-true / primary branch, the
                    // rest are fallbacks — the renderer labels impls[0] "when (cond)". `collect` yields
                    // traversal order, so sort by source position to recover the branch semantics.
                    let mut impls: Vec<String> = Vec::new();
                    if let Some(b) = body {
                        let mut news = ctx.collect(b, |k| k == "new_expression");
                        news.sort_by_key(|n| n.start_byte());
                        for n in news {
                            let name = field(n, "constructor")
                                .map(|c| ctx.text(c).split('(').next().unwrap_or("").trim().to_string())
                                .unwrap_or_default();
                            if !name.is_empty() && !impls.contains(&name) {
                                impls.push(name);
                            }
                        }
                    }
                    let cond = body
                        .and_then(|b| ctx.collect(b, |k| k == "if_statement").into_iter().next())
                        .map(|ifn| strip_parens(field(ifn, "condition").map(|c| ctx.text(c)).unwrap_or("")));
                    bindings.push(DiBinding {
                        token, kind: "toFactory".into(), impls, condition: cond,
                        deps: None, file: rel.to_string(), line,
                    });
                } else {
                    bindings.push(DiBinding {
                        token, kind: "toValue".into(), impls: Vec::new(),
                        condition: None, deps: None, file: rel.to_string(), line,
                    });
                }
                continue;
            }
        }

        // FORM 2: bindModuleToClassOnToken({ token, classs: Impl, depsMap })
        let Some(f) = field(call, "function") else { continue };
        if f.kind() == "identifier" && ctx.text(f) == "bindModuleToClassOnToken" {
            let Some(obj) = arg_at(ctx, call, 0) else { continue };
            if obj.kind() != "object" {
                continue;
            }
            let (mut tok_raw, mut cls): (Option<String>, Option<String>) = (None, None);
            let mut deps: indexmap::IndexMap<String, String> = indexmap::IndexMap::new();
            for p in ctx.children(obj) {
                if p.kind() == "shorthand_property_identifier" {
                    // `{ token, ... }` — the shorthand names the local alias, resolved below
                    if ctx.text(p) == "token" {
                        tok_raw = Some("token".to_string());
                    }
                    continue;
                }
                if p.kind() != "pair" {
                    continue;
                }
                let key = field(p, "key").map(|k| ctx.text(k).to_string());
                let val = field(p, "value");
                match key.as_deref() {
                    Some("token") => tok_raw = val.map(|v| ctx.text(v).to_string()),
                    Some("classs") => {
                        if let Some(v) = val {
                            if v.kind() == "identifier" {
                                cls = Some(ctx.text(v).to_string());
                            }
                        }
                    }
                    Some("depsMap") => {
                        if let Some(v) = val {
                            if v.kind() == "object" {
                                for dp in ctx.collect(v, |k| k == "pair") {
                                    if let (Some(k), Some(vv)) = (field(dp, "key"), field(dp, "value")) {
                                        deps.insert(bare(ctx.text(k)), bare(ctx.text(vv)));
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let (Some(t), Some(c)) = (tok_raw, cls) {
                bindings.push(DiBinding {
                    token: resolve_tok(&t), kind: "toClass".into(), impls: vec![c],
                    condition: None, deps: Some(deps), file: rel.to_string(), line: row_of(call),
                });
            }
        }
    }
    bindings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::treesitter::Ctx;

    fn scan(src: &str) -> Vec<DiBinding> {
        let ctx = Ctx::parse(src, "typescript").expect("typescript grammar");
        scan_di_bindings("m.ts", &ctx)
    }

    #[test]
    fn conditional_to_factory_keeps_both_impls_in_branch_order_with_the_condition() {
        // impls[0] is the condition-TRUE branch and the renderer labels it "when (cond)", so source order
        // is the semantics, not a detail. `collect` yields traversal order, hence the explicit sort.
        let b = &scan(r#"
m.bind(DI_TOKENS.CACHE).toFactory(() => {
  if (process.env.CACHE_URL && process.env.CACHE_TOKEN) {
    return new RealCache();
  }
  return new NoopCache();
}, "singleton");
"#)[0];
        assert_eq!(b.token, "CACHE");
        assert_eq!(b.kind, "toFactory");
        assert_eq!(b.impls, ["RealCache", "NoopCache"]);
        assert_eq!(b.condition.as_deref(), Some("process.env.CACHE_URL && process.env.CACHE_TOKEN"));
    }

    #[test]
    fn a_ternary_factory_has_two_impls_but_no_condition() {
        // there is no `if_statement` to read, so `condition` is None while `impls` still carries both — the
        // branch a single if-shaped fixture silently misses
        let b = &scan("m.bind(DI_TOKENS.CACHE).toFactory(() => (process.env.X ? new A() : new B()));")[0];
        assert_eq!(b.impls, ["A", "B"]);
        assert_eq!(b.condition, None);
    }

    #[test]
    fn a_local_token_alias_resolves_to_the_bare_token_name() {
        // `const token = DI_TOKENS.REPO;` then `.bind(token)` — without the alias map the token would be
        // recorded literally as "token" and never match a lookup
        let b = &scan("const token = DI_TOKENS.REPO;\nm.bind(token).toClass(Repo, []);")[0];
        assert_eq!(b.token, "REPO");
        assert_eq!(b.impls, ["Repo"]);
    }

    #[test]
    fn the_to_class_dep_map_keeps_the_walk_order_not_a_sorted_one() {
        // `deps` crosses to JS as an OBJECT, so its key order is observable. `collect` is a stack DFS, so it
        // yields an object literal's pairs in REVERSE source order — and the TypeScript does the same.
        // Sorting them (the tidy-looking choice) is a real divergence; this pins the faithful order.
        let b = &scan("m.bind(DI_TOKENS.REPO).toClass(Repo, { db: DI_TOKENS.CACHE, other: DI_TOKENS.EXTRA });")[0];
        let keys: Vec<&str> = b.deps.as_ref().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["other", "db"]);
        assert_eq!(b.deps.as_ref().unwrap()["db"], "CACHE");
    }

    #[test]
    fn the_type_safe_helper_reads_a_shorthand_token_property() {
        // `bindModuleToClassOnToken({ module, token, classs: OooRepo })` — `token,` is a shorthand, which is
        // a different AST node than a pair and was one of the two documented parse gotchas
        let b = &scan("const token = DI_TOKENS.OOO;\nconst load = bindModuleToClassOnToken({ module: m, token, classs: OooRepo });")[0];
        assert_eq!(b.token, "OOO");
        assert_eq!(b.kind, "toClass");
        assert_eq!(b.impls, ["OooRepo"]);
    }

    #[test]
    fn to_value_records_the_token_with_no_impls() {
        let b = &scan("m.bind(DI_TOKENS.EXTRA).toValue(42);")[0];
        assert_eq!(b.kind, "toValue");
        assert!(b.impls.is_empty());
    }

    #[test]
    fn a_bare_call_that_is_not_a_binding_contributes_nothing() {
        // `.toClass(` on something that was never `.bind(`-ed must not be mistaken for a binding
        assert!(scan("other.wrap(X).toClass(Y, []);").is_empty());
        assert!(scan("export function nothing() { return 1; }").is_empty());
    }

    #[test]
    fn bare_takes_the_last_dotted_segment_then_strips_quotes() {
        assert_eq!(bare("DI_TOKENS.REDIS_CLIENT"), "REDIS_CLIENT");
        assert_eq!(bare("\"CACHE\""), "CACHE");
        assert_eq!(bare("PLAIN"), "PLAIN");
    }

    #[test]
    fn a_bracket_access_token_is_mangled_a_faithful_carry_over_of_a_real_limitation() {
        // `bare` splits on "." FIRST and strips brackets after, so a bracket-access token with no dot keeps
        // its namespace glued on: `DI_TOKENS['REPO']` -> "DI_TOKENSREPO", which can never match a lookup.
        // The TypeScript does exactly this (verified directly), so the port reproduces it rather than
        // quietly correcting it -- fixing it would change which bindings resolve, which is a product call.
        // Pinned so the behaviour is a decision on record instead of an accident.
        assert_eq!(bare("DI_TOKENS['REPO']"), "DI_TOKENSREPO");
        assert_eq!(bare("a.b['C']"), "bC");
    }

    #[test]
    fn the_line_is_one_based_at_the_outer_call() {
        let b = &scan("\n\nm.bind(DI_TOKENS.REPO).toClass(Repo, []);")[0];
        assert_eq!(b.line, 3);
    }
}
