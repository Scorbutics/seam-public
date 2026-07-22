//! FILE-CHANNEL kind — a data file shared between a writer and a reader (carrier-traced repo-wide, not a
//! per-file scan), so `scan` is empty; registering the KIND wires the channel into the rung machinery. Port of
//! file_channel.ts.

use crate::mask::MaskCtx;
use crate::types::{CouplingAdapter, KeyHit, KindMeta};

static META: KindMeta = KindMeta {
    kind: "data-file",
    node_kind: "data-file",
    produce_edge: "file-write",
    consume_edge: "file-read",
    handler_edge: None,
    terminal: false,
    name: "file-channel",
    blurb: "Shared data-file write ⇄ read (carrier-traced) — file-channel coupling",
    extra_exts: &[],
};

pub struct FileChannel;

impl CouplingAdapter for FileChannel {
    fn meta(&self) -> &KindMeta {
        &META
    }
    fn scan(&self, _file: &str, _text: &str, _mask: &MaskCtx) -> Vec<KeyHit> {
        Vec::new() // carrier-traced repo-wide, not a per-file scan
    }
}
