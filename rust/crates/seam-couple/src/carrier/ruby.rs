//! RUBY carrier adapter — the thin language layer the generic carrier machinery (`carrier/lang.rs`)
//! drives. Supplies the Ruby specifics: how to decompose a `call`, teacher-2 key recovery (literal +
//! interpolated glob), the stdlib SINK REGISTRY (Marshal/File/IO), and resolve delegation to
//! `seam_lang::ruby::dispatch` (whose mixin-MRO + const-nesting model is richer than Java/TS, so it stays
//! bespoke). The scan_file loop, the trace walk, and the effect cache are generic.
//! Port of `languages/ruby/carrier.ts`.

use super::lang::{Call, CarrierLang, KeyPat, Receiver, SinkResult};
use super::trace::Sink;
use seam_lang::dispatch::MethodCandidate;
use seam_lang::ruby::dispatch::{build_ruby_index, const_name, infer_assignments, is_dynamic_dispatch, named_children, resolve_method_call, resolve_self_call, RubyAssign, RubyIndex, EXTENSIONS};
use seam_lang::treesitter::Ctx;
use std::collections::HashMap;
use tree_sitter::Node;

/// KNOWN terminal I/O sinks — CONSTANT-receiver class methods, `Receiver.method`. Closed stdlib set.
fn const_sink(recv: &str, method: &str) -> Option<Sink> {
    let s = match (recv, method) {
        ("Marshal", "dump") => Sink { direction: "write", medium: "serialized" },
        ("Marshal", "load") => Sink { direction: "read", medium: "serialized" },
        ("File", "binwrite") | ("File", "write") | ("IO", "binwrite") | ("IO", "write") => Sink { direction: "write", medium: "file" },
        ("File", "binread") | ("File", "read") | ("IO", "binread") | ("IO", "read") => Sink { direction: "read", medium: "file" },
        _ => return None,
    };
    Some(s)
}

/// INSTANCE-method sinks on a provably-typed stdlib IO object (`@file = File.open` ⇒ `@file.write`). Keyed
/// by method name — applied only when the receiver's inferred type is a stdlib IO type.
fn io_sink(method: &str) -> Option<Sink> {
    let s = match method {
        "write" | "binwrite" | "print" | "puts" | "<<" => Sink { direction: "write", medium: "file" },
        "read" | "binread" | "gets" | "readline" | "readlines" => Sink { direction: "read", medium: "file" },
        _ => return None,
    };
    Some(s)
}

const IO_TYPES: &[&str] = &["File", "IO", "StringIO", "Tempfile"];
/// CODE-EXECUTION terminals — a carrier reaching one loads/runs CODE, not data. `eval`/`*_eval`/`*_exec`
/// for any receiver; the Kernel loaders only when RECEIVER-LESS (`Marshal.load` with a receiver is DATA).
const CODE_EXEC_ANY: &[&str] = &["eval", "instance_eval", "module_eval", "class_eval", "instance_exec", "module_exec", "class_exec"];
const CODE_LOAD_BARE: &[&str] = &["require", "require_relative", "load", "autoload"];

pub struct RubyEnv {
    assigns: Vec<RubyAssign>,
    type_of: HashMap<String, String>,
}

fn receiver_of(ctx: &Ctx, recv: Option<Node>) -> Receiver {
    let Some(recv) = recv else { return Receiver::None };
    if let Some(c) = const_name(ctx, Some(recv)) {
        return Receiver::Type(c);
    }
    if recv.kind() == "identifier" || recv.kind() == "instance_variable" {
        return Receiver::Name(ctx.text(recv).to_string());
    }
    Receiver::Other(ctx.text(recv).to_string())
}

/// TEACHER 2 — a string-literal key, OR a PARTIAL family pattern from an interpolated string
/// (`"Data/#{lang}.dat"` → `Data/*.dat`). A string with no literal content is fully dynamic → no key.
fn key_pattern(ctx: &Ctx, n: Node) -> Option<KeyPat> {
    if n.kind() != "string" {
        return None;
    }
    let mut val = String::new();
    let mut partial = false;
    let mut has_literal = false;
    for c in named_children(n) {
        match c.kind() {
            "interpolation" => {
                val.push('*');
                partial = true;
            }
            "escape_sequence" => return None,
            k if k.contains("content") => {
                val.push_str(ctx.text(c));
                has_literal = true;
            }
            _ => {}
        }
    }
    if !has_literal {
        return None;
    }
    // collapse runs of `*` (`"#{a}#{b}.dat"` → `*.dat`, not `**.dat`)
    let mut collapsed = String::new();
    let mut prev_star = false;
    for ch in val.chars() {
        if ch == '*' {
            if !prev_star {
                collapsed.push('*');
            }
            prev_star = true;
        } else {
            collapsed.push(ch);
            prev_star = false;
        }
    }
    Some(KeyPat { value: collapsed, partial })
}

pub struct RubyCarrier;

impl CarrierLang for RubyCarrier {
    type Idx = RubyIndex;
    type Env = RubyEnv;

    fn name(&self) -> &'static str {
        "Ruby"
    }
    fn extensions(&self) -> &'static [&'static str] {
        EXTENSIONS
    }
    fn call_kind(&self) -> &'static str {
        "call"
    }
    /// Ruby top-level methods are private instance methods of Object
    fn self_fallback(&self) -> Option<&'static str> {
        Some("Object")
    }
    fn grammar(&self, _file: &str) -> &'static str {
        "ruby"
    }
    fn build_index(&self, repo: &str) -> RubyIndex {
        build_ruby_index(repo)
    }

    fn decompose<'a>(&self, ctx: &'a Ctx, call: Node<'a>) -> Option<Call<'a>> {
        let mname = ctx.text(call.child_by_field_name("method")?).to_string();
        let args = call.child_by_field_name("arguments").map(named_children).unwrap_or_default();
        Some(Call { method: mname, receiver: receiver_of(ctx, call.child_by_field_name("receiver")), args, row: ctx.line_of(call.start_byte()) })
    }

    fn key_pattern(&self, ctx: &Ctx, arg: Node) -> Option<KeyPat> {
        key_pattern(ctx, arg)
    }

    fn type_env(&self, ctx: &Ctx) -> RubyEnv {
        let assigns = infer_assignments(ctx);
        // last assignment wins (for the IO-type sink check)
        let type_of = assigns.iter().map(|a| (a.name.clone(), a.fqn.clone())).collect();
        RubyEnv { assigns, type_of }
    }

    fn sink_for(&self, call: &Call, env: &RubyEnv) -> Option<SinkResult> {
        match &call.receiver {
            Receiver::Type(t) => const_sink(t, &call.method).map(SinkResult::Sink),
            Receiver::Name(n) => {
                let t = env.type_of.get(n)?;
                if !IO_TYPES.contains(&t.as_str()) {
                    return None;
                }
                Some(io_sink(&call.method).map(SinkResult::Sink).unwrap_or(SinkResult::Benign))
            }
            _ => None,
        }
    }

    fn is_code_load(&self, call: &Call) -> bool {
        CODE_EXEC_ANY.contains(&call.method.as_str()) || (call.receiver == Receiver::None && CODE_LOAD_BARE.contains(&call.method.as_str()))
    }

    fn is_dynamic(&self, call: &Call) -> bool {
        is_dynamic_dispatch(&call.method)
    }

    fn resolve(&self, index: &RubyIndex, call: &Call, enclosing: Option<&str>, env: &RubyEnv) -> Vec<MethodCandidate> {
        if call.receiver == Receiver::None {
            return enclosing.map(|e| resolve_self_call(index, e, &call.method)).unwrap_or_default();
        }
        let nesting = enclosing.and_then(|e| index.get(e)).map(|i| i.nesting.clone()).unwrap_or_default();
        match call.receiver.text() {
            Some(t) => resolve_method_call(index, t, &call.method, &env.assigns, call.row, &nesting),
            None => Vec::new(),
        }
    }

    fn find_method_node<'a>(&self, ctx: &'a Ctx, method: &str, line: usize) -> Option<Node<'a>> {
        fn visit<'a>(ctx: &'a Ctx, n: Node<'a>, method: &str, line: usize) -> Option<Node<'a>> {
            if (n.kind() == "method" || n.kind() == "singleton_method")
                && n.child_by_field_name("name").map(|x| ctx.text(x)) == Some(method)
                && ctx.line_of(n.start_byte()) == line
            {
                return Some(n);
            }
            for c in named_children(n) {
                if let Some(h) = visit(ctx, c, method, line) {
                    return Some(h);
                }
            }
            None
        }
        visit(ctx, ctx.root(), method, line)
    }
}
