//! The OTHER side of an access — its COMPLEMENTS. If the anchor PRODUCES the key we return its consumers; if
//! it CONSUMES, its producers. A one-directional lookup keyed PURELY on the shared key string — there is NO
//! check the complement points back at THIS producer, which is why every coupling edge is RESOLVED_PARTIAL
//! (a shared-name crossing), never an asserted call. Exact matches, plus (for http-route) suffix-aliased route
//! keys scored by SPECIFICITY so a generic 1-literal fragment can't outrank a specific ≥2-literal reach. Port
//! of otherSide / otherSideScored.

use super::{key_id, GroundingIndex};
use crate::adapters::http_route::{is_bare_wildcard_route, route_match_specificity, route_segs};
use crate::types::Access;
use seam_fs::is_test_file;
use std::collections::HashSet;

const HTTP_ROUTE: &str = "http-route";
// A generic 1-literal route match is a coupling ONLY if it grounds to at most this many files — a SOLE mount.
const GENERIC_ROUTE_FANOUT_CAP: usize = 1;

/// A complement access + the SPECIFICITY of the route it matched on (exact = its full literal count; fuzzy
/// suffix = its shared-literal count; non-route = 0). Port of the `{access, spec}` pair.
pub struct Scored {
    pub access: Access,
    pub spec: i64,
}

/// The SCORED counterpart lookup. Port of `otherSideScored`.
pub fn other_side_scored(index: &GroundingIndex, kind: &str, value: &str, produces: bool) -> Vec<Scored> {
    let side = |sides: &crate::types::KeySides| -> Vec<Access> {
        (if produces { &sides.consumers } else { &sides.producers }).iter().filter(|a| !is_test_file(&a.file)).cloned().collect()
    };
    // exact match is maximally specific: score it by the key's OWN literal-segment count.
    let exact_spec = if kind == HTTP_ROUTE { route_segs(value).iter().filter(|s| **s != "*").count() as i64 } else { 0 };
    let mut out: Vec<Scored> = match index.get(&key_id(kind, value)) {
        Some(sides) => side(sides).into_iter().map(|access| Scored { access, spec: exact_spec }).collect(),
        None => Vec::new(),
    };
    if kind != HTTP_ROUTE {
        return out;
    }
    // A bare-wildcard route has no literal to discriminate on — its exact-key match is a grab-bag. Drop it.
    if is_bare_wildcard_route(value) {
        return Vec::new();
    }
    let prefix = "http-route ";
    // Score every fuzzy route match by shared literal segments.
    let mut scored: Vec<(i64, Vec<Access>)> = Vec::new();
    for (k, v) in index.iter() {
        if !k.starts_with(prefix) {
            continue;
        }
        let val = &k[prefix.len()..];
        if val == value {
            continue; // exact already counted
        }
        let spec = route_match_specificity(val, value);
        if spec >= 1 {
            scored.push((spec, side(v)));
        }
    }
    let has_specific = scored.iter().any(|(spec, _)| *spec >= 2);
    for (spec, accesses) in &scored {
        if *spec >= 2 {
            out.extend(accesses.iter().cloned().map(|access| Scored { access, spec: *spec }));
        }
    }
    if !has_specific {
        // GENERIC fallback — a single shared literal. A SOLE mount is a real coupling; a many-file generic is a
        // coincidental common word, kept only for a producer whose FILE reflects a discriminating segment.
        let generics: Vec<Scored> = scored
            .iter()
            .filter(|(spec, _)| *spec < 2)
            .flat_map(|(spec, accesses)| accesses.iter().cloned().map(move |access| Scored { access, spec: *spec }))
            .collect();
        let files: HashSet<&String> = generics.iter().map(|g| &g.access.file).collect();
        if files.len() <= GENERIC_ROUTE_FANOUT_CAP {
            out.extend(generics);
            return out;
        }
        let segs: Vec<String> = route_segs(value).iter().filter(|x| **x != "*" && x.len() >= 4).map(|s| s.to_lowercase()).collect();
        for g in generics {
            if segs.iter().any(|seg| g.access.file.to_lowercase().contains(seg)) {
                out.push(g);
            }
        }
    }
    out
}

/// The counterpart accesses (score dropped). Port of `otherSide`.
pub fn other_side(index: &GroundingIndex, kind: &str, value: &str, produces: bool) -> Vec<Access> {
    other_side_scored(index, kind, value, produces).into_iter().map(|s| s.access).collect()
}
