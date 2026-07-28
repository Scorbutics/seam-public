//! LEARN / CACHE — the flywheel's persisted output, replayed deterministically. The LLM synthesises adapter
//! rules once; they persist to `.seam/` and this stage replays them warm (0 LLM). Framework-agnostic: a rule is
//! learned DATA (a token + shape + role), not framework code baked into the engine. Port of key_store +
//! key_ir's runMatcher.

pub mod matchers;
pub mod effect_inference;
pub mod discover;
pub mod key_cluster;
pub mod key_index;
pub mod ledger;
pub mod key_store;
pub mod per_file_keys;
pub mod compose_learn;
pub mod receiver_class;
pub mod carrier;

pub use matchers::{load_matchers, run_matcher, run_matcher_at, KeyMatcher};
pub use effect_inference::{infer_http_clients, http_client_matchers, resolve_http_call_sites};
pub use key_index::{apply_matchers, compose_routes, files_index, key_index, module_scope};
pub use discover::{collect_blind, learn_matchers, BlindCollection, LearnOutcome};
pub use per_file_keys::{anchor_proposed_keys, batch_synthesize, candidate_passages, content_key};
pub use compose_learn::{compose_learn, ComposeOutcome};
pub use receiver_class::{classify_annotations, classify_receivers};
pub use carrier::{has_learned_carrier, prefetch_carrier_signatures, resolve_carrier_signature, CarrierSignature, SynthOutcome};
pub use key_store::{cached_file_keys, has_key_cache, persist_file_keys, persist_file_keys_batch, KeyAdapter};

/// THE PROCESS-GLOBAL TEST LOCK. Three things the learn tests touch are per-PROCESS, not per-test: the host
/// bus, `SEAM_ADAPTERS_DIR` (which moves the SHARED matcher store out from under `load_matchers`), and the
/// backend-availability answer that follows from the first. Any two such tests running in parallel see each
/// other's state, and the failure is a plausible wrong result rather than a crash. Every test that installs a
/// bus or sets that env takes this.
#[cfg(test)]
pub(crate) static GLOBAL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
