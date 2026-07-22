//! Shape projections over the footprint builders — deterministic views (impact, reaches, contract, …) a query
//! asks of the resolved graph. Each projection CONSUMES footprints (seam-scan); none builds graph state
//! itself, so this stays a thin layer on top of the scan crate.

pub mod collate;
pub mod contract;
pub mod impact;

pub use collate::locale_compare;
pub use contract::{project_contract, Consumer, ExternalDep, ModuleContract, ProvidedSymbol};
pub use impact::{project_impact, Impact, ImpactFile, ImpactGap, ImpactOpts, ImpactedSymbol};
