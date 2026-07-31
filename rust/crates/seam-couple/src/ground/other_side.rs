//! The OTHER side of an access — its COMPLEMENTS. If the anchor PRODUCES the key we return its consumers; if
//! it CONSUMES, its producers. A one-directional lookup keyed PURELY on the shared key string — there is NO
//! check the complement points back at THIS producer, which is why every coupling edge is RESOLVED_PARTIAL
//! (a shared-name crossing), never an asserted call. Exact matches, plus (for http-route) suffix-aliased route
//! keys scored by SPECIFICITY so a generic 1-literal fragment can't outrank a specific ≥2-literal reach. Port
//! of otherSide / otherSideScored.

use super::{key_id, GroundingIndex};
use crate::adapters::config_key::CONFIG_KEY;
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
    /// What THIS access does — true = it produces the key, false = it consumes it. Read off the side the access
    /// was actually found on, NOT inferred as the complement of the anchor's role.
    ///
    /// The inference was the norm everywhere and it was silently wrong the moment a SYMMETRIC kind existed: a
    /// config key read by four stacks rendered its counterparts as `[method, writes NOTIFY_WEBHOOK_URL]` —
    /// telling a reader that the Java worker SETS the variable, when it only reads it. That is a claim an agent
    /// would act on. For every asymmetric kind this field equals the old assumption, so nothing else moves.
    pub produces: bool,
}

/// The SCORED counterpart lookup. Port of `otherSideScored`.
pub fn other_side_scored(index: &GroundingIndex, kind: &str, value: &str, produces: bool) -> Vec<Scored> {
    // A CONFIG KEY IS SYMMETRIC, and it is the only kind here that is. A table couples a WRITER to a READER and
    // a route couples a CALLER to a HANDLER, so returning the complement is exactly right for both. But two
    // stacks READING the same environment variable are coupled to each other with nobody writing it at all —
    // `api/notify.ts` and `backend/NotifyWorker.java` are both consumers — so a strict complement lookup returns
    // an empty set for the very case the kind exists to catch. Unioning both sides admits reader ⇄ reader while
    // still pairing a definition (`process.env.X = …`, a producer) with its readers. The anchor's own file is
    // dropped downstream by `collect_complement_files`, so a lone accessor is not made its own counterpart.
    // Each returned access is tagged with the side it came FROM: producers are `true`, consumers `false`.
    let side = |sides: &crate::types::KeySides| -> Vec<(Access, bool)> {
        let both = kind == CONFIG_KEY;
        let primary: Vec<(Access, bool)> =
            if produces { sides.consumers.iter().map(|a| (a.clone(), false)).collect() } else { sides.producers.iter().map(|a| (a.clone(), true)).collect() };
        let secondary: Vec<(Access, bool)> = if !both {
            Vec::new()
        } else if produces {
            sides.producers.iter().map(|a| (a.clone(), true)).collect()
        } else {
            sides.consumers.iter().map(|a| (a.clone(), false)).collect()
        };
        primary.into_iter().chain(secondary).filter(|(a, _)| !is_test_file(&a.file)).collect()
    };
    // exact match is maximally specific: score it by the key's OWN literal-segment count.
    let exact_spec = if kind == HTTP_ROUTE { route_segs(value).iter().filter(|s| **s != "*").count() as i64 } else { 0 };
    let mut out: Vec<Scored> = match index.get(&key_id(kind, value)) {
        Some(sides) => side(sides).into_iter().map(|(access, produces)| Scored { access, spec: exact_spec, produces }).collect(),
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
    let mut scored: Vec<(i64, Vec<(Access, bool)>)> = Vec::new();
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
            // ONLY SCORE A KEY THAT ACTUALLY CONTRIBUTES A COUNTERPART. `side(v)` is empty whenever the matched
            // key holds no access on the COMPLEMENTARY side — and such an entry used to be pushed anyway, where
            // it still counted towards `has_specific` below. A high-scoring key with nothing on the other side
            // therefore SUPPRESSED the generic fallback that held the real match, and emitted nothing itself.
            //
            // That is the whole coupling asymmetry. Querying `/admin/realms/*/partial-export` from the Java
            // resource, the anchor's OWN class-level key `/admin/realms/*` scores 2 against it and has no
            // consumers; it silenced the 1-literal match on the client's `/*/partial-export` and the pair
            // resolved in one direction only. It is direction-dependent because that class-level key exists on
            // the Java side and has no counterpart on the TypeScript one.
            let accesses = side(v);
            if !accesses.is_empty() {
                scored.push((spec, accesses));
            }
        }
    }
    let has_specific = scored.iter().any(|(spec, _)| *spec >= 2);
    for (spec, accesses) in &scored {
        if *spec >= 2 {
            out.extend(accesses.iter().cloned().map(|(access, produces)| Scored { access, spec: *spec, produces }));
        }
    }
    if !has_specific {
        // GENERIC fallback — a single shared literal. A SOLE mount is a real coupling; a many-file generic is a
        // coincidental common word, kept only for a producer whose FILE reflects a discriminating segment.
        let generics: Vec<Scored> = scored
            .iter()
            .filter(|(spec, _)| *spec < 2)
            .flat_map(|(spec, accesses)| accesses.iter().cloned().map(move |(access, produces)| Scored { access, spec: *spec, produces }))
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
