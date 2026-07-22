//! LEARN / CACHE — the flywheel's persisted output, replayed deterministically. The LLM synthesises adapter
//! rules once; they persist to `.seam/` and this stage replays them warm (0 LLM). Framework-agnostic: a rule is
//! learned DATA (a token + shape + role), not framework code baked into the engine. Port of key_store +
//! key_ir's runMatcher.

pub mod matchers;
pub mod effect_inference;

pub use matchers::{load_matchers, run_matcher, KeyMatcher};
pub use effect_inference::{infer_http_clients, http_client_matchers, resolve_http_call_sites};
