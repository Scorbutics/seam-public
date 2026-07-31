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

/// Every http-route value each file touches, from the grounding index. Built once per call and only when the
/// generic fallback is actually reached, so the common paths pay nothing.
fn file_route_values(index: &GroundingIndex) -> std::collections::HashMap<String, HashSet<String>> {
    let mut out: std::collections::HashMap<String, HashSet<String>> = std::collections::HashMap::new();
    for (k, sides) in index.iter() {
        let Some(val) = k.strip_prefix("http-route ") else { continue };
        for a in sides.producers.iter().chain(sides.consumers.iter()) {
            out.entry(a.file.clone()).or_default().insert(val.to_string());
        }
    }
    out
}

/// CORROBORATION — does this candidate look like the same API SURFACE as the anchor, or did it merely share one
/// generic word?
///
/// A 1-literal route match is weak on its own. What makes it credible is the REST of the candidate's routes: a
/// file that really serves the anchor's API aligns with it on many paths, while a coincidental word-match aligns
/// on none. Measured on keycloak against `realms.ts`:
///
///   RealmAdminResource.java      17 of 40 routes aligned   (true counterpart)
///   RealmResource.java           18 of 43 routes aligned   (true counterpart)
///   IdentityProvidersResource     0 of  4 routes aligned   (the FALSE pair Seam used to emit)
///
/// 17-18 against 0 is why this needs no tuned threshold, unlike the segment-rarity attempt that preceded it
/// (which had to place a cap inside a measured gap and still broke the `/summarize` suppression).
///
/// The CURRENT key is excluded from both sides — otherwise every match trivially corroborates itself.
fn corroborated(
    index: &GroundingIndex,
    by_file: &std::collections::HashMap<String, HashSet<String>>,
    candidate_file: &str,
    current_value: &str,
    anchor_routes: &[String],
) -> bool {
    let _ = index;
    if anchor_routes.is_empty() {
        return false; // no context supplied → this keeper simply does not apply
    }
    let Some(cand) = by_file.get(candidate_file) else { return false };
    cand.iter()
        .filter(|v| v.as_str() != current_value && !is_bare_wildcard_route(v))
        .any(|cv| {
            anchor_routes
                .iter()
                .filter(|av| av.as_str() != current_value && !is_bare_wildcard_route(av))
                .any(|av| route_match_specificity(cv, av) >= 1)
        })
}

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
pub fn other_side_scored_with_context(index: &GroundingIndex, kind: &str, value: &str, produces: bool, anchor_routes: &[String]) -> Vec<Scored> {
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
        // TWO keepers, ADDITIVE. The filename rule stays: it is the only signal in the `/summarize` case, whose
        // index holds three files, one key and nothing else, so no structural rule can decide it. Corroboration
        // adds the case that rule cannot see — an annotation-routed backend whose filename never mirrors its
        // routes, which is what left keycloak at 20 of 25 keys unresolved.
        let by_file = file_route_values(index);
        for g in generics {
            let name_match = segs.iter().any(|seg| g.access.file.to_lowercase().contains(seg));
            if name_match || corroborated(index, &by_file, &g.access.file, value, anchor_routes) {
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

/// Back-compatible entry point: no anchor context, so the corroboration keeper does not apply and behaviour is
/// exactly as before. Callers that KNOW the anchor's own routes (the coupling shape, the bridge) should use
/// `other_side_scored_with_context` and get the extra recall.
pub fn other_side_scored(index: &GroundingIndex, kind: &str, value: &str, produces: bool) -> Vec<Scored> {
    other_side_scored_with_context(index, kind, value, produces, &[])
}

#[cfg(test)]
mod corroboration_tests {
    use super::*;
    use crate::types::{Access, KeySides};

    fn idx(entries: &[(&str, &[&str], &[&str])]) -> GroundingIndex {
        let mut m = GroundingIndex::new();
        for (k, prods, cons) in entries {
            m.insert((*k).to_string(), KeySides {
                producers: prods.iter().map(|f| Access { file: (*f).to_string(), line: 1 }).collect(),
                consumers: cons.iter().map(|f| Access { file: (*f).to_string(), line: 1 }).collect(),
            });
        }
        m
    }

    #[test]
    fn a_candidate_sharing_the_wider_api_surface_is_corroborated() {
        // The keycloak shape: the handler serves several routes the client also calls, so a weak 1-literal
        // match on one of them is credible. Measured for real at 17/40 and 18/43 aligned.
        let index = idx(&[
            ("http-route /partial-export", &["Res.java"], &[]),
            ("http-route /logout-all", &["Res.java"], &[]),
            ("http-route /*/logout-all", &[], &["client.ts"]),
        ]);
        let by_file = file_route_values(&index);
        let anchor: Vec<String> = vec!["/*/partial-export".into(), "/*/logout-all".into()];
        assert!(corroborated(&index, &by_file, "Res.java", "/*/partial-export", &anchor));
    }

    #[test]
    fn a_candidate_sharing_only_the_one_generic_word_is_not() {
        // The `/summarize` shape: nothing else about this file lines up with the caller's API.
        let index = idx(&[
            ("http-route /summarize/*/*", &["AnalyticsService.java"], &[]),
            ("http-route /reports/*", &["AnalyticsService.java"], &[]),
        ]);
        let by_file = file_route_values(&index);
        let anchor: Vec<String> = vec!["/manage/rest/booking/summarize/0/*".into()];
        assert!(!corroborated(&index, &by_file, "AnalyticsService.java", "/manage/rest/booking/summarize/0/*", &anchor));
    }

    #[test]
    fn without_anchor_context_the_keeper_does_not_apply() {
        // `other_side_scored` (no context) must behave exactly as before — the wrapper relies on this.
        let index = idx(&[("http-route /a/thing", &["X.java"], &[])]);
        let by_file = file_route_values(&index);
        assert!(!corroborated(&index, &by_file, "X.java", "/a/thing", &[]));
    }

    #[test]
    fn a_key_cannot_corroborate_itself() {
        // Without excluding the current key every match would trivially self-corroborate and the keeper would
        // admit everything — the failure mode that makes a "signal" indistinguishable from no rule at all.
        let index = idx(&[("http-route /*/partial-export", &["Only.java"], &[])]);
        let by_file = file_route_values(&index);
        let anchor: Vec<String> = vec!["/*/partial-export".into()];
        assert!(!corroborated(&index, &by_file, "Only.java", "/*/partial-export", &anchor));
    }
}
