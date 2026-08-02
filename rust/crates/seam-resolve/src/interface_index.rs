//! The repo-wide INTERFACE→IMPL (DI binding) index — port of interface_index.ts. Which concrete in-repo
//! classes implement an interface (the runtime `@Inject`/`@Autowired`/CDI wiring a static import scan can't
//! see), plus the zero-arg provider accessors (`GroupProvider groups()`) a DI factory hop goes through.
//! Framework-AGNOSTIC: grounded purely on the structural `implements`/`extends` relation (via the AST scan)
//! and language keywords (the `impl_markers` pre-gate), never a framework annotation. Memoized per repo.

use seam_lang::{ast, grammar_for, provider_for, Ctx};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// A concrete implementation: the class name + the file declaring it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Impl {
    pub cls: String,
    pub file: String,
}

#[derive(Serialize, Deserialize)]
pub struct InterfaceIndex {
    interfaces: HashSet<String>,
    impls: HashMap<String, Vec<Impl>>, // closed to CONCRETE impls (interface-extends expanded)
    accessors: HashMap<String, Vec<String>>, // method → interface(s), INSERTION order (TS Set) — the seed order
}

static CACHE: Lazy<Mutex<HashMap<String, Arc<InterfaceIndex>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

impl InterfaceIndex {
    pub fn cached(repo: &str) -> Arc<InterfaceIndex> {
        if let Some(idx) = CACHE.lock().unwrap().get(repo) {
            return idx.clone();
        }
        let idx = Arc::new(Self::load_or_build(repo));
        CACHE.lock().unwrap().insert(repo.to_string(), idx.clone());
        idx
    }

    fn shard(repo: &str, epoch: &str) -> String {
        format!("{}/rust/interface-index-v1/{epoch}.bin", seam_fs::seam_dir(repo))
    }

    /// DISK-persisted (per-repo content epoch) via direct bincode — a fresh process LOADS instead of re-parsing
    /// the whole repo. Same scheme as CallsiteIndex.
    fn load_or_build(repo: &str) -> Self {
        let perf = seam_fs::debug_on("perf");
        let epoch = seam_cache::epoch_of(repo);
        if !epoch.is_empty() {
            let t = std::time::Instant::now();
            if let Ok(bytes) = std::fs::read(Self::shard(repo, &epoch)) {
                if let Ok(idx) = bincode::deserialize::<InterfaceIndex>(&bytes) {
                    if perf {
                        eprintln!("[perf] interface_index LOAD {:.2}s", t.elapsed().as_secs_f64());
                    }
                    return idx;
                }
            }
        }
        let t = std::time::Instant::now();
        let idx = Self::build(repo);
        if perf {
            eprintln!("[perf] interface_index build {:.2}s", t.elapsed().as_secs_f64());
        }
        if !epoch.is_empty() {
            let dir = format!("{}/rust/interface-index-v1", seam_fs::seam_dir(repo));
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy() != format!("{epoch}.bin") {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
            if let Ok(bytes) = bincode::serialize(&idx) {
                let _ = std::fs::write(Self::shard(repo, &epoch), bytes);
            }
        }
        idx
    }

    pub fn reset(repo: Option<&str>) {
        let mut c = CACHE.lock().unwrap();
        match repo {
            Some(r) => {
                c.remove(r);
            }
            None => c.clear(),
        }
    }

    pub fn build(repo: &str) -> Self {
        let mut interfaces: HashSet<String> = HashSet::new();
        // raw impls in walk order (super → [impl…]); an impl whose `cls` is itself an interface is an
        // interface-extends edge, expanded to concrete impls by the closure below.
        let mut impls: HashMap<String, Vec<Impl>> = HashMap::new();
        let mut raw_accessors: Vec<(String, String)> = Vec::new();
        let add_edge = |sup: String, cls: String, file: String, impls: &mut HashMap<String, Vec<Impl>>| {
            let arr = impls.entry(sup).or_default();
            if !arr.iter().any(|x| x.cls == cls && x.file == file) {
                arr.push(Impl { cls, file });
            }
        };

        use rayon::prelude::*;
        // Parse each candidate file in PARALLEL (the cold cost), then MERGE sequentially in source_files (walk)
        // order so interfaces/impls/accessors are byte-identical to the sequential build. The cheap textual
        // PARSE PRE-GATE stays inside the parallel map so only impl-bearing files actually parse.
        let files = seam_fs::source_files(repo, |r| provider_for(r).is_some());
        let per_file: Vec<Option<ast::ImplContribution>> = files
            .par_iter()
            .map(|rel| {
                let provider = provider_for(rel)?;
                let text = read_text(repo, rel)?;
                // PARSE PRE-GATE (language keywords): skip a file that can't declare an interface/implements. `[]`
                // markers (Ruby) skip every file; Java/TS skip unless the keyword is textually present.
                let markers = provider.impl_markers();
                if !markers.iter().any(|m| text.contains(m)) {
                    return None;
                }
                let grammar = grammar_for(rel)?;
                let ctx = Ctx::parse(&text, grammar)?;
                Some(ast::impl_contribution(&ctx))
            })
            .collect();
        for (rel, contrib) in files.iter().zip(per_file) {
            let Some(contrib) = contrib else { continue };
            for itf in contrib.interfaces {
                interfaces.insert(itf);
            }
            for (sup, cls) in contrib.edges {
                add_edge(sup, cls, rel.clone(), &mut impls);
            }
            for a in contrib.accessors {
                raw_accessors.push(a);
            }
        }

        // TRANSITIVE CLOSURE over interface-extends: expand an impl whose `cls` is itself an interface to that
        // sub-interface's concrete impls, so resolving a SUPER-interface reaches the concrete class.
        let closed = close_to_concrete(&interfaces, &impls);

        // KEEP an accessor only when its return type is a real interface WITH impls (a grounded factory hop).
        let mut accessors: HashMap<String, Vec<String>> = HashMap::new();
        for (m, ret) in raw_accessors {
            if interfaces.contains(&ret) && closed.get(&ret).is_some_and(|v| !v.is_empty()) {
                let v = accessors.entry(m).or_default();
                if !v.contains(&ret) {
                    v.push(ret);
                }
            }
        }

        Self { interfaces, impls: closed, accessors }
    }

    /// The concrete in-repo implementations of interface `name`, sorted by file. Empty unless `name` is a
    /// declared interface (we never chase a concrete class's subclasses). Port of `impls_of`.
    pub fn impls_of(&self, name: &str) -> Vec<Impl> {
        if !self.interfaces.contains(name) {
            return Vec::new();
        }
        let mut out = self.impls.get(name).cloned().unwrap_or_default();
        out.sort_by(|a, b| a.file.cmp(&b.file));
        out
    }

    /// The DI provider accessors: method name → the interface(s) its zero-arg form returns. Port of
    /// `provider_accessors`.
    pub fn accessors(&self) -> &HashMap<String, Vec<String>> {
        &self.accessors
    }

    /// Is `name` an in-repo interface that HAS impls? (the `getProvider(X.class)` grounding gate). Port of
    /// `is_provider_interface`.
    pub fn is_provider_interface(&self, name: &str) -> bool {
        self.interfaces.contains(name) && self.impls.get(name).is_some_and(|v| !v.is_empty())
    }
}

fn close_to_concrete(interfaces: &HashSet<String>, impls: &HashMap<String, Vec<Impl>>) -> HashMap<String, Vec<Impl>> {
    fn resolve_concrete(name: &str, interfaces: &HashSet<String>, impls: &HashMap<String, Vec<Impl>>, seen: &mut HashSet<String>) -> Vec<Impl> {
        let mut out = Vec::new();
        for e in impls.get(name).into_iter().flatten() {
            if interfaces.contains(&e.cls) {
                if seen.insert(e.cls.clone()) {
                    out.extend(resolve_concrete(&e.cls, interfaces, impls, seen));
                }
            } else {
                out.push(e.clone());
            }
        }
        out
    }
    let mut closed: HashMap<String, Vec<Impl>> = HashMap::new();
    for name in impls.keys() {
        let mut seen = HashSet::from([name.clone()]);
        let mut uniq: Vec<Impl> = Vec::new();
        for e in resolve_concrete(name, interfaces, impls, &mut seen) {
            if !uniq.iter().any(|x| x.cls == e.cls && x.file == e.file) {
                uniq.push(e);
            }
        }
        if !uniq.is_empty() {
            closed.insert(name.clone(), uniq);
        }
    }
    closed
}

fn read_text(repo: &str, rel: &str) -> Option<String> {
    std::fs::read(format!("{repo}/{rel}")).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// The interface names a class `symbol` (in `anchor_file`) IMPLEMENTS. Used to reach the facade-style
/// upstream entries a bidirectional grow misses: DI/CDI consumers import the INTERFACE, not the impl, so
/// growing consumers of the impl finds nothing — growing consumers of its interfaces does (deterministic).
/// Port of `implemented_interfaces`.
pub fn implemented_interfaces(repo: &str, anchor_file: &str, symbol: &str) -> Vec<String> {
    let Some(ctx) = parse_file(repo, anchor_file) else { return Vec::new() };
    let Some(cls) = ctx.collect(ctx.root(), seam_lang::node_kinds::is_class_kind).into_iter().find(|c| ast::name_of(&ctx, *c).as_deref() == Some(symbol)) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for b in ast::heritage_bases(&ctx, cls, seam_lang::node_kinds::is_implements) {
        if !out.contains(&b) {
            out.push(b);   // the TS side dedups with a Set, which preserves first-seen order
        }
    }
    out
}

/// FRAMEWORK-ENTRY detection — generalized, NO per-framework annotation list. A `symbol` (method or class) is
/// a framework/external entry when it's wired declaratively: (a) it carries a METHOD-LEVEL
/// annotation/decorator (any — `@GET`/`@Schedule`/`@PostConstruct`/`@Observes`/a TS `@Get()`…; presence is the
/// signal, not the name), or (b) its enclosing class implements an EXTERNAL interface (one not declared in
/// this repo, e.g. `MessageListener` → `onMessage` is the framework callback). Combined by the caller with
/// "no in-repo caller", this distinguishes a framework ROOT (flow enters here from outside the repo) from
/// genuinely-isolated/dead code — across any annotation/decorator framework. Port of `is_framework_entry`.
pub fn is_framework_entry(repo: &str, file: &str, symbol: &str) -> bool {
    use seam_lang::node_kinds as nk;
    let Some(ctx) = parse_file(repo, file) else { return false };
    // (a) a method-LEVEL annotation/decorator (in `modifiers`, or a sibling decorator) — NOT param/return ones.
    // NB: a method's NAME is the identifier right before its parameter list — NOT `name_of` (which returns the
    // first name-kind child = the RETURN TYPE for `String foo()`; fine for classes, wrong for typed methods).
    let mname = |m: seam_lang::Node| -> String {
        let ch = ctx.children(m);
        if let Some(fp) = ch.iter().position(|c| c.kind().starts_with("formal_param")) {
            if fp > 0 {
                for i in (0..fp).rev() {
                    if ch[i].kind() == "identifier" || ch[i].kind() == "property_identifier" {
                        return ctx.text(ch[i]).to_string();
                    }
                }
            }
        }
        ast::name_of(&ctx, m).unwrap_or_default()
    };
    let method = ctx.collect(ctx.root(), nk::is_method_kind).into_iter().find(|m| mname(*m) == symbol);
    if let Some(m) = method {
        let ch = ctx.children(m);
        if let Some(mods) = ch.iter().find(|c| c.kind() == "modifiers") {
            if ctx.children(*mods).iter().any(|c| nk::is_annotation(c.kind())) {
                return true;
            }
        }
        if ch.iter().any(|c| nk::is_annotation(c.kind())) {
            return true; // TS decorator sibling
        }
    }
    // (b) enclosing class implements an interface NOT declared in-repo → framework callback impl.
    let idx = InterfaceIndex::cached(repo);
    for cls in ctx.collect(ctx.root(), nk::is_class_kind) {
        let impls = ast::heritage_bases(&ctx, cls, nk::is_implements);
        if !impls.iter().any(|i| !idx.interfaces.contains(i)) {
            continue; // no external interface here
        }
        if ast::name_of(&ctx, cls).as_deref() == Some(symbol) {
            return true;
        }
        if let Some(m) = method {
            let (ms, _) = ctx.span(m);
            let (cs, ce) = ctx.span(cls);
            if ms >= cs && ms <= ce {
                return true;
            }
        }
    }
    false
}

// Read + parse one file, or None (unknown extension / unreadable / unparseable) — the shared prelude of both
// per-anchor scans above.
fn parse_file(repo: &str, rel: &str) -> Option<Ctx> {
    let grammar = grammar_for(rel)?;
    let text = read_text(repo, rel)?;
    Ctx::parse(&text, grammar)
}
