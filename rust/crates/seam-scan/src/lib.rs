//! Footprint builders — graphs grown around an anchor (the "up"/consumers + "down"/deps slices). The first is
//! build_callsite_graph (a class/method's call-site consumers).

mod builder;
pub mod callsite_graph;
pub mod class_graph;
pub mod consumers_graph;
pub mod attach;
pub mod dependency_graph;
pub mod footprint;
pub mod graph;
pub mod merge;
pub mod module_graph;
pub mod string_coupling;
mod util;

pub use callsite_graph::{build_callsite_graph, CallsiteOpts};
pub use class_graph::build_class_graph;
pub use consumers_graph::{build_consumers_graph, ConsumersOpts};
pub use dependency_graph::{build_dependency_graph, DepOpts};
pub use footprint::build_bidirectional_graph;
pub use graph::{Blindspot, Candidate, GraphEdge, GraphNode, ResolvedGraph, Unresolved};
pub use merge::merge_resolved;
pub use module_graph::build_module_graph;
