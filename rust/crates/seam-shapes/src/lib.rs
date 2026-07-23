//! Shape projections over the footprint builders — deterministic views (impact, reaches, contract, …) a query
//! asks of the resolved graph. Each projection CONSUMES footprints (seam-scan); none builds graph state
//! itself, so this stays a thin layer on top of the scan crate.

pub mod collate;
pub mod compare;
pub mod contract;
pub mod impact;
pub mod project_set;
pub mod reach;
pub mod refactor_facts;
pub mod neighborhood;

pub use collate::locale_compare;
pub use compare::{project_compare, Comparison, CompareOpts, Dep};
pub use contract::{project_contract, Consumer, ExternalDep, ModuleContract, ProvidedSymbol};
pub use impact::{project_impact, Impact, ImpactFile, ImpactGap, ImpactOpts, ImpactedSymbol};
pub use project_set::{
    attach_recalled, project_consumer_set, project_dependency_set, ConsumerMember, ConsumerSet,
    NameConsumer, UnresolvedCaller,
};
pub use reach::{find_reach, ReachOpts, ReachResult, ReachStep};
pub use refactor_facts::{gather_refactor_facts, RefactorFacts};
pub use neighborhood::{project_neighborhood, Neighborhood, NeighborFile, NeighborhoodOpts};
