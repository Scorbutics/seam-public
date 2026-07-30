//! The UP / CONSUMERS footprint (where a symbol is used) — the routing layer that completes `--query
//! consumers`. `build_resolved_graph` is the import-scan core (anchor + import-resolved consumers + intra-file
//! callers), routing a CLASS anchor to build_class_graph. `build_consumers_graph` wraps it, merging the
//! receiver-agnostic call-site pass for interface/method/class anchors the import scan is blind to.
//!
//! SCOPE: the STRUCTURAL core — the data-coupling overlay, the depth-2 ripple, and the non-source file-ref
//! path are later migration phases, so this is the `dataCoupling:false`, depth-1, source-anchor graph
//! (validated against TS with those options).

use crate::builder::GraphBuilder;
use crate::class_graph::{build_class_graph, callsite_new_consumers_only, reconcile_class_attribution};
use crate::callsite_graph::{build_callsite_graph, CallsiteOpts};
use crate::graph::{Candidate, ResolvedGraph};
use crate::merge::merge_resolved;
use crate::util::{kind_for, read};
use seam_fs::stem;
use seam_lang::ast::{self, Unit};
use seam_lang::{node_kinds as nk, provider_for, Ctx};
use seam_resolve::{Status, Workspace};
use std::collections::HashSet;

pub struct ConsumersOpts {
    pub anchor_line: Option<usize>,
    /// The consumer DEPTH. 1 (the default) is the direct-caller floor; 2+ additionally runs the environment
    /// ripple — each exported depth-1 consumer's own importers, as the boundary frontier.
    pub depth: usize,
    /// Skip the receiver-agnostic call-site pass (blast-radius counts don't need it).
    pub skip_callsite: bool,
    /// Run the dataCoupling OVERLAY (resolveCoupling + route-consumer chaining). Structural-only when false.
    pub data_coupling: bool,
    /// LSP-verified method attribution for a CLASS anchor (`--attribution`), or None.
    pub verified: Option<crate::class_graph::Verified>,
}

// `depth: 1` is the DEFAULT depth, not 0 — `..Default::default()` must mean "the direct-caller floor", the
// same thing `opts.depth ?? 1` means on the TS side.
impl Default for ConsumersOpts {
    fn default() -> Self {
        Self { anchor_line: None, depth: 1, skip_callsite: false, data_coupling: false, verified: None }
    }
}

/// The import-scan core: anchor node + import-resolved consumers + same-file callers. A CLASS anchor is
/// forwarded to build_class_graph. Port of `build_resolved_graph` (structural core).
pub fn build_resolved_graph(repo: &str, anchor_file: &str, symbol: &str, opts: &ConsumersOpts) -> Option<ResolvedGraph> {
    let src = read(repo, anchor_file);
    let (actx, aunits) = match &src {
        Some((text, lang)) => match Ctx::parse(text, lang) {
            Some(c) => {
                let u = ast::named_units(&c);
                (Some(c), u)
            }
            None => (None, Vec::new()),
        },
        None => (None, Vec::new()),
    };

    // anchor kind + range
    let (mut kind, mut range) = ("symbol".to_string(), (0usize, 0usize));
    if let Some(defu) = aunits.iter().find(|u| u.name == symbol) {
        kind = defu.kind.clone();
        range = (defu.start, defu.end);
    } else if let Some(c) = &actx {
        if let Some(w) = ast::wrapped_def_span(c, symbol, &aunits) {
            kind = "function".into();
            range = w;
        }
    }
    if let Some(al) = opts.anchor_line {
        range = (al, al.max(range.1));
    }
    if kind == "class" {
        return build_class_graph(repo, anchor_file, symbol, opts.data_coupling, opts.verified.as_ref());
    }

    let enclosing = if kind == "method" {
        aunits.iter().find(|u| u.kind == "class" && u.start <= range.0 && range.1 <= u.end).map(|u| u.name.clone()).unwrap_or_default()
    } else {
        String::new()
    };
    let lang = provider_for(anchor_file).map(|p| p.name().to_string()).unwrap_or_default();
    let mut b = GraphBuilder::new(symbol, &kind, anchor_file, range, &enclosing, &lang);

    add_import_consumers(&mut b, repo, anchor_file, symbol);
    // REVERSE FILE-PATH REFERENCE — source files that name THIS file by a path LITERAL (a component's
    // styleUrls, a `require('./x.css')`) are its consumers, so a template/asset anchor reaches its owner.
    // Gated to NON-SOURCE anchors (a code file's users come through the import scan above). Port of the
    // `fileReferencers` block in build_resolved_graph.
    if seam_lang::provider_for(anchor_file).is_none() {
        let anchor_norm = seam_fs::normpath(anchor_file);
        for (file, line) in seam_resolve::file_ref::file_referencers(repo, anchor_file) {
            if seam_fs::normpath(&file) == anchor_norm {
                continue;
            }
            b.add_consumer(format!("{file}#fileref"), &stem(&file), "module", &file, (line, line), "", "file-ref", "RESOLVED_FULL", None);
        }
    }
    if kind != "symbol" {
        if let Some(c) = &actx {
            let text = src.as_ref().map(|(t, _)| t.as_str()).unwrap_or("");
            add_intra_file_callers(&mut b, repo, c, anchor_file, text, symbol, range, &aunits);
        }
    }
    // OPAQUE DEFAULT SLOT — the honest middle answer between asserting and lying. When this file's `export
    // default` is an EXPRESSION that resolves to no declaration of the file (an anonymous `() => …`, a wrapper
    // whose impl argument is not a local funclike), its default importers are real consumers that NO symbol
    // here can carry. Reported only when the anchor otherwise has ZERO edges — exactly where the render would
    // say "Nothing in the repo calls this symbol". Port of the consumers_graph.ts opaque-default block.
    if !b.has_edges() {
        let ws = Workspace::cached(repo);
        if let Some(expr) = ws.opaque_default_slot(anchor_file) {
            let imps = ws.default_importers(anchor_file);
            if !imps.is_empty() {
                b.add_blindspot(
                    "opaque-default-export",
                    format!(
                        "{anchor_file} has `export default {expr}` — an expression this file declares no name for, so its {} default-import consumer(s) cannot be attributed to {symbol} or to any other symbol here",
                        imps.len()
                    ),
                    imps.iter().take(8).map(|f| Candidate { symbol: f.clone(), ..Default::default() }).collect(),
                );
            }
        }
    }
    // THE DEPTH-2 RIPPLE, before the coupling overlay — the id order depends on it (TS runs it here too).
    if opts.depth >= 2 {
        b.ripple_depth2(repo, &Workspace::cached(repo));
    }
    // dataCoupling OVERLAY — the anchor's shared-key boundaries + route-consumer chain (whole-file span when
    // the symbol didn't resolve). Port of the consumers_graph.ts dataCoupling block.
    if opts.data_coupling {
        if let Some((text, _)) = &src {
            b.overlay_coupling(repo, anchor_file, text, range, &Workspace::cached(repo));
        }
    }
    Some(b.into_graph())
}

/// Import-resolved consumers: each file importing `symbol`, attributed to the enclosing unit(s) that use it.
fn add_import_consumers(b: &mut GraphBuilder, repo: &str, anchor_file: &str, symbol: &str) {
    let ws = Workspace::cached(repo);
    for con in ws.scan_consumers(anchor_file, symbol) {
        if con.status == Status::Suggested {
            b.add_blindspot(
                "unresolved-import",
                format!("{} imports {} from '{}' (module unresolved)", con.file, symbol, con.source),
                vec![Candidate { symbol: con.file.clone(), ..Default::default() }],
            );
            b.add_unresolved("resolveModule", format!("unresolved:{}", con.source));
            continue;
        }
        let Some((ctext, clang)) = read(repo, &con.file) else { continue };
        let Some(cctx) = Ctx::parse(&ctext, &clang) else { continue };
        let units = ast::named_units(&cctx);
        // NO USAGE IN A BODY — the bare BARREL / re-export case (`export { X } from "./x"`), and the plain
        // "imported but only re-bound" one. The import statement IS a real, locatable site in the consumer's
        // own file, and the resolver already grounded its 0-based line (`Consumer::line`), so cite THAT. `0`
        // remains a SENTINEL for "no site at all": it must never reach an EDGE nor be rendered — 0 is not a
        // valid line, and after the 0-based→1-based conversion it reads as `file:1`, a FABRICATED citation
        // pointing at an unrelated first line. Nodes placed on the sentinel are marked `unlocated` so every
        // projection can omit the location instead of inventing one. Port of 8dccfbf.
        let mut lines = ast::usage_lines(&cctx, &units, &con.local);
        let mut grounded = !lines.is_empty();
        if lines.is_empty() {
            if let Some(l) = con.line {
                lines = vec![l];
                grounded = true;
            } else {
                lines = vec![0];
            }
        }
        for ln in lines {
            let (name, kind, start, end, cls) = match ast::enclosing(&units, ln) {
                Some(u) => {
                    // FIRST containing class in walk order (TS `.find`, not the tightest) → the node's enclosing.
                    let cls = units.iter().find(|x| x.kind == "class" && x.start <= u.start && u.end <= x.end).map(|x| x.name.clone()).unwrap_or_default();
                    (u.name.clone(), u.kind.clone(), u.start, u.end, cls)
                }
                None => (stem(&con.file), "module".to_string(), ln, ln, String::new()),
            };
            let key = format!("{}#{}#{}", con.file, name, start);
            b.add_consumer_located(key, &name, &kind_for(&con.file, &kind), &con.file, (start, end), &cls, "reference", "RESOLVED_FULL", Some(ln), grounded);
        }
    }
}

/// Same-file callers: a function in the anchor file that CALLS `symbol` (FULL) or otherwise references it
/// (PARTIAL) — a real consumer the import scan can't see. Definition-body lines are skipped.
#[allow(clippy::too_many_arguments)]
fn add_intra_file_callers(b: &mut GraphBuilder, repo: &str, actx: &Ctx, anchor_file: &str, anchor_src: &str, symbol: &str, arange: (usize, usize), aunits: &[Unit]) {
    // NAME COLLISION with an IMPORT. The name match here is only sound while the anchor OWNS the bare name in
    // its own file. When the file also IMPORTS that name, the import is the module-scope binding, so every BARE
    // `symbol(...)` there is provably the IMPORTED symbol — a different thing that merely shares the name — and
    // attributing it to the anchor is a false RESOLVED_FULL "verified edge" (cal.com: the METHOD
    // RegularBookingService.createBooking vs `import { createBooking } from "../handleNewBooking/createBooking"`,
    // called bare at :1939). Only the BARE sites are dropped: a receiver-qualified `this.symbol()` / `x.symbol()`
    // is a member access, never the import, so genuine same-file method callers survive. Proof-gated — an
    // unresolved module leaves the old behaviour intact, so no false positive is traded for a false negative.
    // Port of 72df701.
    let (bare, qualified) = ast::ref_lines_split(actx, symbol);
    let import_bound = crate::def_resolve::import_binds_elsewhere(repo, anchor_file, anchor_src, symbol);
    let mut call_seen: HashSet<usize> = HashSet::new();
    let mut call_order: Vec<usize> = Vec::new();
    if !import_bound {
        for ln in ast::call_lines(actx, symbol) {
            // `call_lines` is bare-name only by construction
            if call_seen.insert(ln) {
                call_order.push(ln);
            }
        }
    }
    for ln in &call_order {
        add_caller(b, anchor_file, symbol, arange, aunits, *ln, "call", "RESOLVED_FULL");
    }
    let ref_lines: Vec<usize> = if import_bound {
        qualified
    } else {
        let mut v: Vec<usize> = bare.into_iter().chain(qualified).collect();
        v.sort_unstable();
        v.dedup();
        v
    };
    for ln in ref_lines {
        if !call_seen.contains(&ln) {
            add_caller(b, anchor_file, symbol, arange, aunits, ln, "reference", "RESOLVED_PARTIAL");
        }
    }
}

fn add_caller(b: &mut GraphBuilder, anchor_file: &str, symbol: &str, arange: (usize, usize), aunits: &[Unit], ln: usize, edge_kind: &str, prov: &str) {
    if ln >= arange.0 && ln <= arange.1 {
        return; // inside the anchor's own body (recursion / the def itself)
    }
    let Some(enc) = ast::enclosing(aunits, ln) else { return };
    if enc.name == symbol {
        return;
    }
    let key = format!("{}#{}#{}", anchor_file, enc.name, enc.start);
    b.add_consumer(key, &enc.name, &kind_for(anchor_file, &enc.kind), anchor_file, (enc.start, enc.end), "", edge_kind, prov, Some(ln));
}

/// UP / consumers — for a plain function this is `build_resolved_graph`; an INTERFACE/METHOD/CLASS anchor also
/// merges its call-site pass (the DI/abstraction usage the import scan can't see). Port of `build_consumers_graph`.
pub fn build_consumers_graph(repo: &str, anchor_file: &str, symbol: &str, opts: &ConsumersOpts) -> Option<ResolvedGraph> {
    let mut base = build_resolved_graph(repo, anchor_file, symbol, opts)?;
    let Some((text, lang)) = read(repo, anchor_file) else { return Some(base) };
    let Some(ctx) = Ctx::parse(&text, &lang) else { return Some(base) };

    let is_interface = ctx.collect(ctx.root(), nk::is_interface).iter().any(|c| ast::name_of(&ctx, *c).as_deref() == Some(symbol));
    // METHOD-LIKE also covers a class FIELD holding a function — `m = withReporting(this._m.bind(this))`,
    // `m = (x) => …`. Such a field is NOT a `named_units` unit, so without this the receiver-agnostic call-site
    // pass never runs and `consumers` returns 0 for a symbol with real callers. Mirrors `isFieldFn` in
    // consumers_graph.ts (whose absence here was a silent TS/Rust divergence on this anchor shape).
    let is_field_fn =
        !is_interface && ctx.collect(ctx.root(), nk::is_class_field).iter().any(|f| ast::name_of(&ctx, *f).as_deref() == Some(symbol));
    let is_method =
        !is_interface && (is_field_fn || ast::named_units(&ctx).iter().any(|u| u.name == symbol && u.kind == "method"));
    let is_class = !is_interface && !is_method && ctx.collect(ctx.root(), nk::is_class_kind).iter().any(|c| ast::name_of(&ctx, *c).as_deref() == Some(symbol));

    let __perf = seam_fs::debug_on("perf");
    let __t = std::time::Instant::now();
    if !opts.skip_callsite && (is_interface || is_method || is_class) {
        let cs_opts = CallsiteOpts {
            anchor_line: opts.anchor_line,
            method_names: if is_method { Some(vec![symbol.to_string()]) } else { None },
            owner_class: if is_class { Some(symbol.to_string()) } else { None },
        };
        let __t_cs = std::time::Instant::now();
        let Some(mut callsite) = build_callsite_graph(repo, anchor_file, symbol, &cs_opts) else { return Some(base) };
        let __cs = __t_cs.elapsed().as_secs_f64();
        let __t_rest = std::time::Instant::now();
        if is_class {
            callsite = callsite_new_consumers_only(&base, callsite, symbol);
        }
        base = merge_resolved(&base, &callsite, None);
        if is_class {
            let methods: Vec<String> = ast::class_methods(&ctx, symbol).into_iter().map(|(n, _, _)| n).collect();
            reconcile_class_attribution(&mut base, &callsite, symbol, &methods);
        }
        if __perf {
            eprintln!("[perf]   consumers_graph {symbol}: callsite_graph={__cs:.2}s merge+reconcile={:.2}s total={:.2}s nodes={}",
                __t_rest.elapsed().as_secs_f64(), __t.elapsed().as_secs_f64(), base.nodes.len());
        }
    }
    Some(base)
}
