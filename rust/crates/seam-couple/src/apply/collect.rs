//! STEP 1+2 — COLLECT the keys the anchor span touches, from the deterministic per-file scan (source "scan"),
//! carrier-channel accesses ("carrier"), and LLM proposals ("llm"), deduped by (kind,value,produces,label).
//! The representative producer of a table is chosen by op-class (CREATE < UPDATE/ambiguous < DELETE) then
//! earliest line — so the spine crowns `booking.create`, not a later `booking.update`. Port of collectAnchorKeys.

use crate::mask::MaskCtx;
use crate::types::KeyHit;
use indexmap::IndexMap;
use std::collections::HashSet;

/// Where a key came from — drives the blindspot gate (an ungrounded floor key is dropped, an ungrounded llm
/// proposal is surfaced). Port of `KeySource`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeySource {
    Scan,
    Carrier,
    Llm,
}

/// One key the anchor touches, tagged with its source. Port of `AnchorKey`.
#[derive(Clone, Debug)]
pub struct AnchorKey {
    pub kind: String,
    pub value: String,
    pub produces: bool,
    pub line: usize,
    pub source: KeySource,
    pub label: Option<String>,
    pub op: Option<String>,
}

impl AnchorKey {
    /// The deterministic floor (scan|carrier), vs an LLM proposal. Port of `isFloor`.
    pub fn is_floor(&self) -> bool {
        self.source != KeySource::Llm
    }
}

fn access_id(k: &KeyHit) -> String {
    format!("{} {} {} {}", k.kind, k.value, k.produces, k.label.as_deref().unwrap_or(""))
}

// create < update/ambiguous < delete
fn op_rank(op: &Option<String>) -> u8 {
    match op.as_deref() {
        Some("create") => 0,
        Some("delete") => 2,
        _ => 1,
    }
}

/// Collect the keys the anchor body touches (STEP 1 scan + carrier + STEP 2 llm proposals), deduped. Insertion
/// order preserved (JS Map). Port of `collectAnchorKeys`.
pub fn collect_anchor_keys(
    anchor_file: &str,
    anchor_text: &str,
    span_lo: usize,
    span_hi: usize,
    carrier_accs: &[KeyHit],
    proposed: &[KeyHit],
    http_recv: &HashSet<String>,
) -> IndexMap<String, AnchorKey> {
    let mut keys: IndexMap<String, AnchorKey> = IndexMap::new();

    let mut add_floor = |hit: &KeyHit, source: KeySource, keys: &mut IndexMap<String, AnchorKey>| {
        if hit.line < span_lo || hit.line > span_hi {
            return;
        }
        if hit.kind == "db-table" {
            if let Some(recv) = &hit.recv {
                if http_recv.contains(recv) {
                    return; // an HTTP-client receiver → member_access phantom, drop
                }
            }
        }
        let id = access_id(hit);
        let better = match keys.get(&id) {
            None => true,
            Some(cur) => op_rank(&hit.op) < op_rank(&cur.op) || (op_rank(&hit.op) == op_rank(&cur.op) && hit.line < cur.line),
        };
        if better {
            keys.insert(
                id,
                AnchorKey {
                    kind: hit.kind.clone(),
                    value: hit.value.clone(),
                    produces: hit.produces,
                    line: hit.line,
                    source,
                    label: hit.label.clone(),
                    op: hit.op.clone(),
                },
            );
        }
    };

    let mask = MaskCtx::new(anchor_text);
    for hit in crate::adapters::scan_file_keys(anchor_file, anchor_text, &mask) {
        add_floor(&hit, KeySource::Scan, &mut keys);
    }
    for hit in carrier_accs {
        add_floor(hit, KeySource::Carrier, &mut keys);
    }
    // LLM proposals — anchored at span start, only where the floor missed them.
    for pk in proposed {
        let id = access_id(pk);
        if !keys.contains_key(&id) {
            keys.insert(
                id,
                AnchorKey { kind: pk.kind.clone(), value: pk.value.clone(), produces: pk.produces, line: span_lo, source: KeySource::Llm, label: pk.label.clone(), op: pk.op.clone() },
            );
        }
    }
    keys
}
