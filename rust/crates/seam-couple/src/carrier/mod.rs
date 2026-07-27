//! THE CARRIER AXIS (deterministic half) — homemade-framework channel coupling. A project's own
//! `save_data(x, path)` / `load_data(path)` wrappers are invisible to every framework adapter, because the
//! framework is the project's. The carrier axis recovers them: trace a called repo method to a stdlib I/O
//! SINK (teacher 1), read the channel key out of its string argument (teacher 2), and index writer against
//! reader repo-wide. What the tracer cannot follow is OPAQUE, and is deferred to the learned-signature
//! store (teacher 3) in `learn::carrier` — which is a pure cache read here, never an inline model call.
//!
//! Ported alongside `learn::carrier` (its teacher-3 half, which landed first). Only RUBY has a provider;
//! see `engine::PROVIDERS` for why that is the whole registry rather than a first slice of it.

pub mod engine;
pub mod lang;
pub mod provider;
pub mod ruby;
pub mod trace;

pub use engine::{anchor_carrier_accs, carrier_channel_index, reset_carrier_indexes, resolve_anchor_carrier, CarrierOpts};
pub use provider::{glob_match, CarrierObservation, CarrierProvider};
