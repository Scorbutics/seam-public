//! THE language-agnostic carrier machinery. A language plugs in a thin `CarrierLang` adapter (grammar
//! node-kinds + a sink registry + how to read a call) and gets, for free: the provider `scan_file` loop
//! (teacher 2 + orchestration), the trace WALK's classify ladder (teacher 1), the per-index effect cache,
//! and the method-source lookup. Everything that would otherwise be copy-pasted per language lives here
//! ONCE; the per-language files are just what the grammar forces to differ.
//! Port of `coupling/carrier/lang.ts`.

use super::provider::{CarrierObservation, CarrierProvider};
use super::trace::{trace_to_sinks, CallGraph, CarrierEffect, Sink, TraceCall};
use seam_lang::dispatch::{pinned, MethodCandidate, MethodIndex};
use seam_lang::treesitter::Ctx;
use std::any::Any;
use std::collections::HashMap;
use std::sync::Mutex;
use tree_sitter::Node;

/// A call's receiver, normalised so the shared classifier/resolver never touches an AST.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Receiver {
    /// a bare, receiver-less call (self in Ruby/Java; module scope in TS)
    None,
    /// explicit this/self → the enclosing class
    Zelf,
    /// a Type/constant receiver (Files, Marshal, Store)
    Type(String),
    /// a variable / ivar / identifier receiver
    Name(String),
    /// a chain / computed / otherwise-unknown receiver
    Other(String),
}

impl Receiver {
    /// The receiver's written text, for the receivers that HAVE one — the three the classifier treats as
    /// "a real receiver we couldn't pin".
    pub fn text(&self) -> Option<&str> {
        match self {
            Receiver::Type(t) | Receiver::Name(t) | Receiver::Other(t) => Some(t),
            _ => None,
        }
    }
}

/// A decomposed call: the normalised currency the generic machinery reads instead of grammar nodes.
pub struct Call<'a> {
    pub method: String,
    pub receiver: Receiver,
    pub args: Vec<Node<'a>>,
    pub row: usize,
}

/// A teacher-2 channel key recovered from a call argument.
#[derive(Clone, Debug)]
pub struct KeyPat {
    pub value: String,
    pub partial: bool,
}

/// Sink classification: a real I/O sink, a benign op on a known-IO receiver (neither sink nor blindspot —
/// stops the fall-through to resolution), or `None` = not I/O (resolve & follow it).
pub enum SinkResult {
    Sink(Sink),
    Benign,
}

/// The THIN per-language adapter. `Idx` = the language's index (must expose the common method shape);
/// `Env` = whatever per-method type evidence the language wants to thread (opaque to the generic).
pub trait CarrierLang: Send + Sync + 'static {
    type Idx: MethodIndex + Send + Sync + 'static;
    type Env: Send + Sync;

    fn name(&self) -> &'static str;
    fn extensions(&self) -> &'static [&'static str];
    /// tree-sitter call node kind to collect
    fn call_kind(&self) -> &'static str;
    /// enclosing scope for a self/bare call with no class
    fn self_fallback(&self) -> Option<&'static str>;
    fn grammar(&self, file: &str) -> &'static str;
    fn build_index(&self, repo: &str) -> Self::Idx;
    /// a call node → a normalised Call
    fn decompose<'a>(&self, ctx: &'a Ctx, node: Node<'a>) -> Option<Call<'a>>;
    /// teacher 2
    fn key_pattern(&self, ctx: &Ctx, arg: Node) -> Option<KeyPat>;
    /// per-file type evidence (for sinks + var resolution)
    fn type_env(&self, ctx: &Ctx) -> Self::Env;
    fn sink_for(&self, call: &Call, env: &Self::Env) -> Option<SinkResult>;
    fn is_code_load(&self, call: &Call) -> bool;
    fn is_dynamic(&self, call: &Call) -> bool;
    /// → index-backed candidates
    fn resolve(&self, index: &Self::Idx, call: &Call, enclosing: Option<&str>, env: &Self::Env) -> Vec<MethodCandidate>;
    fn find_method_node<'a>(&self, ctx: &'a Ctx, method: &str, line: usize) -> Option<Node<'a>>;
}

/// The provider's boxed per-repo state: the language index plus the two memos the TS side kept in
/// WeakMaps keyed by the index object (the repo-wide method-name set and the per-method effect cache).
pub struct IndexBox<I> {
    pub index: I,
    repo_methods: std::collections::HashSet<String>,
    effects: Mutex<HashMap<String, CarrierEffect>>,
}

fn read_file(repo: &str, rel: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Classify one decomposed call into a generic `TraceCall` (the shared teacher-1 ladder).
fn classify<L: CarrierLang>(lang: &L, index: &L::Idx, call: &Call, enclosing: Option<&str>, env: &L::Env, repo_methods: &std::collections::HashSet<String>) -> TraceCall {
    if lang.is_code_load(call) {
        return TraceCall::CodeLoad;
    }
    if let Some(sr) = lang.sink_for(call, env) {
        return match sr {
            SinkResult::Sink(s) => TraceCall::Sink { direction: s.direction, medium: s.medium },
            SinkResult::Benign => TraceCall::Ignore,
        };
    }
    if lang.is_dynamic(call) {
        return TraceCall::Dynamic { label: format!("dynamic:{}", call.method) };
    }
    let hits = pinned(lang.resolve(index, call, enclosing, env));
    if !hits.is_empty() {
        return TraceCall::Follow { targets: hits };
    }
    // a real receiver we couldn't pin → opaque/blindspot
    if let Some(rt) = call.receiver.text() {
        return TraceCall::Unresolved {
            external: true,
            blindspot: if repo_methods.contains(&call.method) { Some(format!("{rt}.{}", call.method)) } else { None },
        };
    }
    TraceCall::Ignore // a self/bare call we couldn't resolve → not a carrier
}

/// The language's `CallGraph` (a method body → its classified calls) for the generic walk.
struct LangGraph<'a, L: CarrierLang> {
    lang: &'a L,
    repo: &'a str,
    boxed: &'a IndexBox<L::Idx>,
}

impl<L: CarrierLang> CallGraph for LangGraph<'_, L> {
    fn calls_of(&self, class_name: &str, method: &str) -> Option<Vec<TraceCall>> {
        let def = self.boxed.index.method_def(class_name, method)?;
        let text = read_file(self.repo, &def.file)?;
        let ctx = Ctx::parse(&text, self.lang.grammar(&def.file))?;
        let mnode = self.lang.find_method_node(&ctx, method, def.line)?;
        let env = self.lang.type_env(&ctx);
        let call_kind = self.lang.call_kind();
        let mut out = Vec::new();
        for node in ctx.collect(mnode, |k| k == call_kind) {
            if let Some(call) = self.lang.decompose(&ctx, node) {
                out.push(classify(self.lang, &self.boxed.index, &call, Some(class_name), &env, &self.boxed.repo_methods));
            }
        }
        Some(out)
    }
}

/// The generic `CarrierProvider` — the `scan_file` loop (teacher 2 key recovery → resolve → trace effect →
/// emit observation) wrapped around the adapter. Identical for every language, so it is written ONCE as a
/// blanket impl rather than a factory the way TS spells it.
impl<L: CarrierLang> CarrierProvider for L {
    fn name(&self) -> &'static str {
        CarrierLang::name(self)
    }

    fn handles(&self, file: &str) -> bool {
        self.extensions().iter().any(|e| file.ends_with(e))
    }

    fn build_index(&self, repo: &str) -> Box<dyn Any + Send + Sync> {
        let index = CarrierLang::build_index(self, repo);
        let repo_methods = index.repo_method_names();
        Box::new(IndexBox { index, repo_methods, effects: Mutex::new(HashMap::new()) })
    }

    fn method_source(&self, repo: &str, index: &(dyn Any + Send + Sync), class_name: &str, method: &str) -> Option<String> {
        let boxed = index.downcast_ref::<IndexBox<L::Idx>>()?;
        let def = boxed.index.method_def(class_name, method)?;
        let text = read_file(repo, &def.file)?;
        let ctx = Ctx::parse(&text, self.grammar(&def.file))?;
        let node = self.find_method_node(&ctx, method, def.line)?;
        Some(ctx.text(node).to_string())
    }

    fn scan_file(&self, repo: &str, index: &(dyn Any + Send + Sync), file: &str, text: &str) -> Vec<CarrierObservation> {
        let Some(boxed) = index.downcast_ref::<IndexBox<L::Idx>>() else { return Vec::new() };
        let Some(ctx) = Ctx::parse(text, self.grammar(file)) else { return Vec::new() };
        let env = self.type_env(&ctx);
        let graph = LangGraph { lang: self, repo, boxed };

        // The per-(class,method) effect memo — one trace per carrier per repo index, however many call
        // sites reach it.
        let eff_of = |cls: &str, m: &str| -> CarrierEffect {
            let k = format!("{cls}#{m}");
            if let Some(hit) = boxed.effects.lock().unwrap().get(&k) {
                return hit.clone();
            }
            let e = trace_to_sinks(&graph, cls, m);
            boxed.effects.lock().unwrap().insert(k, e.clone());
            e
        };

        let call_kind = self.call_kind();
        let mut out = Vec::new();
        for node in ctx.collect(ctx.root(), |k| k == call_kind) {
            let Some(call) = self.decompose(&ctx, node) else { continue };
            let Some(key) = call.args.iter().find_map(|a| self.key_pattern(&ctx, *a)) else { continue };
            let enclosing = boxed.index.enclosing_class(file, call.row, self.self_fallback());
            for c in pinned(self.resolve(&boxed.index, &call, enclosing.as_deref(), &env)) {
                let eff = eff_of(&c.class_name, &c.method);
                if eff.code_load {
                    continue;
                }
                let dir = if eff.directions.iter().any(|d| d == "write") {
                    Some("write")
                } else if eff.directions.iter().any(|d| d == "read") {
                    Some("read")
                } else {
                    None
                };
                if let Some(dir) = dir {
                    out.push(CarrierObservation {
                        value: key.value.clone(),
                        partial: key.partial,
                        line: call.row,
                        callee_class: c.class_name.clone(),
                        callee_method: c.method.clone(),
                        direction: Some(dir.to_string()),
                    });
                    continue;
                }
                if eff.external && eff.directions.is_empty() {
                    out.push(CarrierObservation {
                        value: key.value.clone(),
                        partial: key.partial,
                        line: call.row,
                        callee_class: c.class_name.clone(),
                        callee_method: c.method.clone(),
                        direction: None,
                    });
                }
            }
        }
        out
    }
}
