//! Footprint builders — graphs grown around an anchor (the "up"/consumers + "down"/deps slices). The first is
//! build_callsite_graph (a class/method's call-site consumers).

mod builder;
pub mod callsite_graph;
pub mod class_graph;
pub mod consumers_graph;
pub mod graph;
pub mod merge;
pub mod module_graph;
mod util;

pub use callsite_graph::{build_callsite_graph, CallsiteOpts};
pub use class_graph::build_class_graph;
pub use consumers_graph::{build_consumers_graph, ConsumersOpts};
pub use graph::{Blindspot, Candidate, GraphEdge, GraphNode, ResolvedGraph, Unresolved};
pub use merge::merge_resolved;
pub use module_graph::build_module_graph;
