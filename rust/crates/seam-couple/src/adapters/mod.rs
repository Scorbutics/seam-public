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
pub mod config_key;
mod db_table;
pub mod endpoint_map;
mod file_channel;
mod http_egress;
pub mod http_route;
mod jooq;
mod jpa_entity;
mod member_access;
mod raw_sql;
mod vue_inject;

static SUPABASE: db_table::Supabase = db_table::Supabase;
static RAW_SQL: raw_sql::RawSql = raw_sql::RawSql;
static ACTIVE_RECORD: active_record::ActiveRecord = active_record::ActiveRecord;
static JOOQ: jooq::Jooq = jooq::Jooq;
static JPA_ENTITY: jpa_entity::JpaEntity = jpa_entity::JpaEntity;
static HTTP_ROUTE: http_route::HttpRoute = http_route::HttpRoute;
static HTTP_EGRESS: http_egress::HttpEgress = http_egress::HttpEgress;
static ENDPOINT_MAP: endpoint_map::EndpointMap = endpoint_map::EndpointMap;
static ANNOTATION_ROUTE: annotation_route::AnnotationRoute = annotation_route::AnnotationRoute;
static FILE_CHANNEL: file_channel::FileChannel = file_channel::FileChannel;
static VUE_INJECT: vue_inject::VueInject = vue_inject::VueInject;
static MEMBER_ACCESS: member_access::MemberAccess = member_access::MemberAccess;
static CONFIG_KEY: config_key::ConfigKey = config_key::ConfigKey;

/// Every registered framework adapter, in the TS `ADAPTERS` order (so `scan_file_keys` is byte-identical).
/// CONFIG_KEY is APPENDED rather than inserted: it has no TS counterpart (it was added after the TS floor was
/// deleted), and putting it last keeps every pre-existing key's discovery order unchanged.
/// Framework-specific code lives ONLY in these modules. SUPABASE is registry slot 0: it grounds query-builder
/// `.from(t).verb` table access via the language provider's `table_access`, which no language implements (the
/// TS hook is unimplemented everywhere) — so it emits nothing on every repo, byte-identical, but it is
/// registered FIRST to match the TS order and appear in the adapter catalogue.
static ADAPTERS: &[&dyn CouplingAdapter] =
    &[&SUPABASE, &RAW_SQL, &ACTIVE_RECORD, &JOOQ, &JPA_ENTITY, &HTTP_ROUTE, &HTTP_EGRESS, &ENDPOINT_MAP, &ANNOTATION_ROUTE, &FILE_CHANNEL, &VUE_INJECT, &MEMBER_ACCESS, &CONFIG_KEY];

/// Every adapter's shared-key accesses in one file (the deterministic floor scan), filtered by the universal
/// plausibility guard. Port of `scan_file_keys`.
pub fn scan_file_keys(file: &str, text: &str, mask: &MaskCtx) -> Vec<KeyHit> {
    // SEAM_NO_ADAPTERS=1 UNLINKS the hand-written adapters — the framework-agnostic scaffold: whatever the
    // engine still recovers with the floor empty is what it recovers WITHOUT per-framework knowledge (the
    // carrier axis, the learned matchers). Without this the "unlink" arm silently measures the linked floor
    // and the agnosticism claim is untested. Port of the `SEAM_NO_ADAPTERS` early return in `scanFileKeys`.
    if std::env::var("SEAM_NO_ADAPTERS").as_deref() == Ok("1") {
        return Vec::new();
    }
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

/// Is `edge_kind` a WRITE (produce) edge — the SRC of it PRODUCES the key/subject (a db write, a dispatched
/// message)? TS: `KEY_PRODUCE_EDGE_KINDS = new Set([...ADAPTERS, GENERIC].map((k) => k.produceEdge))` — the
/// REGISTERED detection adapters' produce edges plus GENERIC's `key-write` (NOT the full archetype set). Port of
/// `isProduceEdge`.
pub fn is_produce_edge(edge_kind: &str) -> bool {
    edge_kind == "key-write" /* GENERIC */ || ADAPTERS.iter().any(|a| a.meta().produce_edge == edge_kind)
}

/// The raw hits of ONE adapter (by its `name`) over a file — no plausibility filter. Per-adapter validation
/// surface; `None` for an unknown adapter name.
pub fn adapter_keys(name: &str, file: &str, text: &str) -> Option<Vec<KeyHit>> {
    let mask = MaskCtx::new(text);
    ADAPTERS.iter().find(|a| a.meta().name == name).map(|a| a.scan(file, text, &mask))
}
