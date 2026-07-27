//! CARRIER-TRACING — the language-agnostic mechanism (teacher 1). Given a method, follow each call it
//! makes (resolved by the language's dispatch) until it reaches a KNOWN I/O SINK, learning the method's
//! effect: direction (read/write) + medium (file/serialized/…). This is what turns a homemade-framework
//! wrapper (`Yuki::VD#write_data`) into a classified carrier deterministically.
//!
//! The WALK lives here — depth cap, cycle guard, union-of-directions over followed candidates, honest
//! blindspots. What's irreducibly per-language — reading the AST, the dispatch resolution, and the
//! stdlib SINK REGISTRY (Ruby's Marshal/File, Java's Files/ObjectOutputStream, …) — lives behind the
//! `CallGraph` seam: the language CLASSIFIES each call site into a generic `TraceCall`, and this walk
//! only routes them. (Over-approximation via the direction union is safe — we union sink directions
//! across followed candidates; unresolved/dynamic calls are recorded as blindspots.)
//! Port of `coupling/carrier/trace.ts`.

use seam_lang::dispatch::MethodCandidate;
use std::collections::HashSet;

pub type Direction = &'static str; // "read" | "write"

/// One known terminal I/O effect — a direction + the medium reached. The registry mapping a call to a
/// Sink is the language's (stdlib knowledge); this is just the shape.
#[derive(Clone, Copy, Debug)]
pub struct Sink {
    pub direction: Direction,
    pub medium: &'static str,
}

#[derive(Clone, Debug, Default)]
pub struct CarrierEffect {
    pub class_name: String,
    pub method: String,
    /// empty = no sink reached
    pub directions: Vec<String>,
    pub media: Vec<String>,
    /// in-repo hops followed
    pub reached: Vec<(String, String)>,
    /// dynamic / unresolved calls met on the way
    pub blindspots: Vec<String>,
    /// reaches a code-execution sink → loads CODE, not data
    pub code_load: bool,
    /// delegates to a call we couldn't resolve to a sink or in-repo method (opaque → teacher-3 candidate)
    pub external: bool,
}

/// A method-body call, ALREADY classified by the language front-end (it read the AST; the walk never
/// sees a node). The closed set of things a call can be on the way to a sink.
#[derive(Clone, Debug)]
pub enum TraceCall {
    /// a known terminal I/O op → contributes its direction + medium
    Sink { direction: Direction, medium: &'static str },
    /// loads/runs CODE not data (require/eval) → the carrier is a code-loader, not a channel
    CodeLoad,
    /// truly-dynamic dispatch (send/method_missing) → an honest blindspot, NOT external
    Dynamic { label: String },
    /// delegates to a call we couldn't pin (`external` → opaque teacher-3 candidate); `blindspot` set when
    /// the unresolved name is one the repo DOES define (a recall loss)
    Unresolved { external: bool, blindspot: Option<String> },
    /// resolved to PINNED in-repo def(s) → recurse into each
    Follow { targets: Vec<MethodCandidate> },
    /// a builtin / non-carrier op (or a typed receiver whose method isn't a sink) → nothing
    Ignore,
}

/// The language front-end the generic tracer drives. `calls_of` returns the classified calls in a
/// method's body, or `None` when the def isn't in this language's index.
pub trait CallGraph {
    fn calls_of(&self, class_name: &str, method: &str) -> Option<Vec<TraceCall>>;
}

const DEPTH_CAP: usize = 12;

fn push_unique(v: &mut Vec<String>, s: &str) {
    if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
    }
}

/// Trace a method's body to its I/O sinks via the language `CallGraph`. Pure routing + accumulation —
/// no AST, no language knowledge. Port of `traceToSinks`.
pub fn trace_to_sinks(graph: &dyn CallGraph, class_name: &str, method: &str) -> CarrierEffect {
    let mut eff = CarrierEffect { class_name: class_name.to_string(), method: method.to_string(), ..Default::default() };
    let mut seen: HashSet<String> = HashSet::new();
    visit(graph, class_name, method, 0, &mut eff, &mut seen);
    eff
}

fn visit(graph: &dyn CallGraph, cls: &str, meth: &str, depth: usize, eff: &mut CarrierEffect, seen: &mut HashSet<String>) {
    let key = format!("{cls}#{meth}");
    if seen.contains(&key) || depth > DEPTH_CAP {
        return;
    }
    seen.insert(key);
    let Some(calls) = graph.calls_of(cls, meth) else { return };
    for c in calls {
        match c {
            TraceCall::Sink { direction, medium } => {
                push_unique(&mut eff.directions, direction);
                push_unique(&mut eff.media, medium);
            }
            TraceCall::CodeLoad => eff.code_load = true,
            TraceCall::Dynamic { label } => push_unique(&mut eff.blindspots, &label),
            TraceCall::Unresolved { external, blindspot } => {
                if external {
                    eff.external = true;
                }
                if let Some(b) = blindspot {
                    push_unique(&mut eff.blindspots, &b);
                }
            }
            TraceCall::Follow { targets } => {
                for t in targets {
                    eff.reached.push((t.class_name.clone(), t.method.clone()));
                    visit(graph, &t.class_name, &t.method, depth + 1, eff, seen);
                }
            }
            TraceCall::Ignore => {}
        }
    }
}
