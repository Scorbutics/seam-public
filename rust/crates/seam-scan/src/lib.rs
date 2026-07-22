//! Footprint builders — graphs grown around an anchor (the "up"/consumers + "down"/deps slices). The first is
//! build_callsite_graph (a class/method's call-site consumers).

pub mod callsite_graph;
pub mod graph;

pub use callsite_graph::{build_callsite_graph, CallsiteOpts};
pub use graph::{GraphEdge, GraphNode, ResolvedGraph};
