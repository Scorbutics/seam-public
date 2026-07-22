//! The coupling ADAPTER REGISTRY — the ONLY place framework knowledge lives (each adapter a small isolated
//! module), dispatched here so the coupling engine stays framework-agnostic. Adding a framework = one module
//! + one registry entry, exactly as adding a language is one module under `seam-lang`. Port of adapters/index.ts.
//!
//! (Adapters land incrementally — the registry is the contract; JPA/JAX-RS/raw-SQL/etc. slot in next.)

use crate::key_ir::plausible_key_value;
use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit};

/// Every registered framework adapter. Framework-specific code lives ONLY in these modules.
static ADAPTERS: &[&dyn CouplingAdapter] = &[];

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
