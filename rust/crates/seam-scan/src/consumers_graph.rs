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

#[derive(Default)]
pub struct ConsumersOpts {
    pub anchor_line: Option<usize>,
    /// Skip the receiver-agnostic call-site pass (blast-radius counts don't need it).
    pub skip_callsite: bool,
    /// Run the dataCoupling OVERLAY (resolveCoupling + route-consumer chaining). Structural-only when false.
    pub data_coupling: bool,
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
        return build_class_graph(repo, anchor_file, symbol, opts.data_coupling);
    }

    let enclosing = if kind == "method" {
        aunits.iter().find(|u| u.kind == "class" && u.start <= range.0 && range.1 <= u.end).map(|u| u.name.clone()).unwrap_or_default()
    } else {
        String::new()
    };
    let lang = provider_for(anchor_file).map(|p| p.name().to_string()).unwrap_or_default();
    let mut b = GraphBuilder::new(symbol, &kind, anchor_file, range, &enclosing, &lang);

    add_import_consumers(&mut b, repo, anchor_file, symbol);
    // The reverse file-path reference (a template/asset anchor's consumers) applies only to NON-source
    // anchors; a source file's users come through the import scan above. Deferred with the file-ref index.
    // if provider_for(anchor_file).is_none() { … fileReferencers … }
    if kind != "symbol" {
        if let Some(c) = &actx {
            add_intra_file_callers(&mut b, c, anchor_file, symbol, range, &aunits);
        }
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
        let mut lines = ast::usage_lines(&cctx, &units, &con.local);
        if lines.is_empty() {
            lines = vec![0];
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
            b.add_consumer(key, &name, &kind_for(&con.file, &kind), &con.file, (start, end), &cls, "reference", "RESOLVED_FULL");
        }
    }
}

/// Same-file callers: a function in the anchor file that CALLS `symbol` (FULL) or otherwise references it
/// (PARTIAL) — a real consumer the import scan can't see. Definition-body lines are skipped.
fn add_intra_file_callers(b: &mut GraphBuilder, actx: &Ctx, anchor_file: &str, symbol: &str, arange: (usize, usize), aunits: &[Unit]) {
    let mut call_seen: HashSet<usize> = HashSet::new();
    let mut call_order: Vec<usize> = Vec::new();
    for ln in ast::call_lines(actx, symbol) {
        if call_seen.insert(ln) {
            call_order.push(ln);
        }
    }
    for ln in &call_order {
        add_caller(b, anchor_file, symbol, arange, aunits, *ln, "call", "RESOLVED_FULL");
    }
    for ln in ast::ref_lines(actx, symbol) {
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
    b.add_consumer(key, &enc.name, &kind_for(anchor_file, &enc.kind), anchor_file, (enc.start, enc.end), "", edge_kind, prov);
}

/// UP / consumers — for a plain function this is `build_resolved_graph`; an INTERFACE/METHOD/CLASS anchor also
/// merges its call-site pass (the DI/abstraction usage the import scan can't see). Port of `build_consumers_graph`.
pub fn build_consumers_graph(repo: &str, anchor_file: &str, symbol: &str, opts: &ConsumersOpts) -> Option<ResolvedGraph> {
    let mut base = build_resolved_graph(repo, anchor_file, symbol, opts)?;
    let Some((text, lang)) = read(repo, anchor_file) else { return Some(base) };
    let Some(ctx) = Ctx::parse(&text, &lang) else { return Some(base) };

    let is_interface = ctx.collect(ctx.root(), nk::is_interface).iter().any(|c| ast::name_of(&ctx, *c).as_deref() == Some(symbol));
    let is_method = !is_interface && ast::named_units(&ctx).iter().any(|u| u.name == symbol && u.kind == "method");
    let is_class = !is_interface && !is_method && ctx.collect(ctx.root(), nk::is_class_kind).iter().any(|c| ast::name_of(&ctx, *c).as_deref() == Some(symbol));

    if !opts.skip_callsite && (is_interface || is_method || is_class) {
        let cs_opts = CallsiteOpts {
            anchor_line: opts.anchor_line,
            method_names: if is_method { Some(vec![symbol.to_string()]) } else { None },
            owner_class: if is_class { Some(symbol.to_string()) } else { None },
        };
        let Some(mut callsite) = build_callsite_graph(repo, anchor_file, symbol, &cs_opts) else { return Some(base) };
        if is_class {
            callsite = callsite_new_consumers_only(&base, callsite, symbol);
        }
        base = merge_resolved(&base, &callsite);
        if is_class {
            let methods: Vec<String> = ast::class_methods(&ctx, symbol).into_iter().map(|(n, _, _)| n).collect();
            reconcile_class_attribution(&mut base, &callsite, symbol, &methods);
        }
    }
    Some(base)
}
