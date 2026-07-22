//! The coupling layer — shared-key data-flow boundaries (DB tables, HTTP routes, file channels) that the
//! call/import graph can't see. The ENGINE (mask, plausibility floor, grounding index, crossing resolution)
//! is framework-AGNOSTIC; all framework knowledge is isolated in `adapters/` behind the `CouplingAdapter`
//! trait, the coupling counterpart of `seam-lang`'s language providers.

pub mod adapters;
pub mod grounding;
pub mod ground;
pub mod frameworks;
pub mod regex_util;
pub mod verb_class;
pub mod key_ir;
pub mod mask;
pub mod types;

pub use adapters::{adapter_keys, scan_file_keys};
pub use ground::{floor_base_index, floor_indices, key_id, merge_grounding, other_side, other_side_scored, FloorIndices, GroundingIndex};
pub use grounding::file_store_write_count;
pub use types::{Access, KeySides};
pub use key_ir::{line_of, plausible_key_value};
pub use mask::{mask_comments, string_literals_only, MaskCtx};
pub use types::{CouplingAdapter, KeyHit, KindMeta};
