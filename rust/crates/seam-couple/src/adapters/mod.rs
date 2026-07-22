//! The coupling ADAPTER REGISTRY — the ONLY place framework knowledge lives (each adapter a small isolated
//! module), dispatched here so the coupling engine stays framework-agnostic. Adding a framework = one module
//! + one registry entry, exactly as adding a language is one module under `seam-lang`. Port of adapters/index.ts.
//!
//! (Adapters land incrementally — the registry is the contract; JPA/JAX-RS/raw-SQL/etc. slot in next.)

use crate::key_ir::plausible_key_value;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit};

mod annotation_route;
mod db_table;
mod http_route;
mod jpa_entity;
mod raw_sql;

static RAW_SQL: raw_sql::RawSql = raw_sql::RawSql;
static JPA_ENTITY: jpa_entity::JpaEntity = jpa_entity::JpaEntity;
static ANNOTATION_ROUTE: annotation_route::AnnotationRoute = annotation_route::AnnotationRoute;

/// Every registered framework adapter, in the TS `ADAPTERS` order (so `scan_file_keys` is byte-identical).
/// Framework-specific code lives ONLY in these modules.
static ADAPTERS: &[&dyn CouplingAdapter] = &[&RAW_SQL, &JPA_ENTITY, &ANNOTATION_ROUTE];

/// Every adapter's shared-key accesses in one file (the deterministic floor scan), filtered by the universal
/// plausibility guard. Port of `scan_file_keys`.
pub fn scan_file_keys(file: &str, text: &str, mask: &MaskCtx) -> Vec<KeyHit> {
    ADAPTERS
        .iter()
        .flat_map(|a| a.scan(file, text, mask))
        .filter(|h| plausible_key_value(&h.value))
        .collect()
}

/// The registered adapters' metadata catalogue (`seam-adapters`).
pub fn builtin_adapters() -> Vec<(&'static str, &'static str, &'static str)> {
    ADAPTERS.iter().map(|a| (a.meta().name, a.meta().kind, a.meta().blurb)).collect()
}

/// The raw hits of ONE adapter (by its `name`) over a file — no plausibility filter. Per-adapter validation
/// surface; `None` for an unknown adapter name.
pub fn adapter_keys(name: &str, file: &str, text: &str) -> Option<Vec<KeyHit>> {
    let mask = MaskCtx::new(text);
    ADAPTERS.iter().find(|a| a.meta().name == name).map(|a| a.scan(file, text, &mask))
}
