//! LEARN / CACHE — the flywheel's persisted output, replayed deterministically. The LLM synthesises adapter
//! rules once; they persist to `.seam/` and this stage replays them warm (0 LLM). Framework-agnostic: a rule is
//! learned DATA (a token + shape + role), not framework code baked into the engine. Port of key_store +
//! key_ir's runMatcher.

pub mod matchers;
pub mod effect_inference;
pub mod discover;
pub mod key_cluster;
pub mod key_index;
pub mod key_store;
pub mod per_file_keys;
pub mod compose_learn;

pub use matchers::{load_matchers, run_matcher, run_matcher_at, KeyMatcher};
pub use effect_inference::{infer_http_clients, http_client_matchers, resolve_http_call_sites};
pub use key_index::{apply_matchers, compose_routes, files_index, key_index, module_scope};
pub use discover::{collect_blind, learn_matchers, BlindCollection, LearnOutcome};
pub use per_file_keys::{anchor_proposed_keys, batch_synthesize, candidate_passages, content_key};
pub use compose_learn::{compose_learn, ComposeOutcome};
pub use key_store::{cached_file_keys, has_key_cache, persist_file_keys, persist_file_keys_batch, KeyAdapter};
