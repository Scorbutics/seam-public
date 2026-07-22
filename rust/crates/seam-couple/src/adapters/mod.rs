//! The coupling ADAPTER REGISTRY — the ONLY place framework knowledge lives (each adapter a small isolated
//! module), dispatched here so the coupling engine stays framework-agnostic. Adding a framework = one module
//! + one registry entry, exactly as adding a language is one module under `seam-lang`. Port of adapters/index.ts.
//!
//! (Adapters land incrementally — the registry is the contract; JPA/JAX-RS/raw-SQL/etc. slot in next.)

use crate::key_ir::plausible_key_value;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit};

mod active_record;
mod annotation_route;
mod db_table;
mod file_channel;
mod http_egress;
mod http_route;
mod jooq;
mod jpa_entity;
mod member_access;
mod raw_sql;

static RAW_SQL: raw_sql::RawSql = raw_sql::RawSql;
static ACTIVE_RECORD: active_record::ActiveRecord = active_record::ActiveRecord;
static JOOQ: jooq::Jooq = jooq::Jooq;
static JPA_ENTITY: jpa_entity::JpaEntity = jpa_entity::JpaEntity;
static HTTP_EGRESS: http_egress::HttpEgress = http_egress::HttpEgress;
static ANNOTATION_ROUTE: annotation_route::AnnotationRoute = annotation_route::AnnotationRoute;
static FILE_CHANNEL: file_channel::FileChannel = file_channel::FileChannel;
static MEMBER_ACCESS: member_access::MemberAccess = member_access::MemberAccess;

/// Every registered framework adapter, in the TS `ADAPTERS` order (so `scan_file_keys` is byte-identical).
/// Framework-specific code lives ONLY in these modules.
static ADAPTERS: &[&dyn CouplingAdapter] = &[&RAW_SQL, &ACTIVE_RECORD, &JOOQ, &JPA_ENTITY, &HTTP_EGRESS, &ANNOTATION_ROUTE, &FILE_CHANNEL, &MEMBER_ACCESS];

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
