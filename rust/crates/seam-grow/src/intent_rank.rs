//! Deterministic intent-relevance banding — port of `bandTiers` and `markSpineMembers` in
//! `ts/src/codebase/grow/intent_rank.ts`.
//!
//! Rank-banded, not threshold-based: there is no magic cosine cutoff that drifts per repo or per model. The
//! top band is the spine, the middle supporting, the tail off — decided by POSITION in the relevance
//! ordering, with one relative floor on top.
use serde::{Deserialize, Serialize};

/// Fraction of the RUN'S TOP relevance below which a seam is off-intent however it ranks. Relative, not an
/// absolute cosine, so it is reproducible and does not drift per repo/model. It only ever DEMOTES — it crops
/// the long mildly-relevant tail out of `supporting`; the top seam is always kept.
const OFF_INTENT_FLOOR: f64 = 0.5;
/// "The path" inside a tangled blob is a handful, not the top third — capped hard.
const SPINE_MEMBER_CAP: usize = 12;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Banded {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relevance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
}

/// Band the seams into spine/supporting/off by their position in the relevance ordering.
///
/// A STRUCTURAL spine (the crossing backbone, locked in emit) takes precedence: a spine seam is never
/// re-banded, and no MORE spine is minted from text similarity — the embeddings then only split the
/// remainder two ways. Only when there is no structural spine at all (a policy fan, a same-language flow
/// with no boundary) does the embedding band define the spine itself.
pub fn band_tiers(seams: &mut [Banded]) {
    let locked_spine = seams.iter().any(|s| s.tier.as_deref() == Some("spine"));
    // indices of the scored, non-spine seams, ordered by relevance DESC
    let mut idx: Vec<usize> = (0..seams.len())
        .filter(|i| seams[*i].relevance.is_some() && seams[*i].tier.as_deref() != Some("spine"))
        .collect();
    if idx.is_empty() {
        return;
    }
    idx.sort_by(|a, b| {
        seams[*b].relevance.unwrap_or(0.0).partial_cmp(&seams[*a].relevance.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let n = idx.len();
    let floor = seams[idx[0]].relevance.unwrap_or(0.0) * OFF_INTENT_FLOOR;
    // ceil division, matching the TypeScript's Math.ceil(n/2) / Math.ceil(n/3) band edges
    let ceil_div = |a: usize, b: usize| (a + b - 1) / b;
    for (rank, i) in idx.iter().enumerate() {
        let rel = seams[*i].relevance.unwrap_or(0.0);
        let tier = if rel < floor {
            "off"
        } else if locked_spine {
            if rank < ceil_div(n, 2) { "supporting" } else { "off" }
        } else if rank < ceil_div(n, 3) {
            "spine"
        } else if rank < ceil_div(2 * n, 3) {
            "supporting"
        } else {
            "off"
        };
        seams[*i].tier = Some(tier.to_string());
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Member {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relevance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spine: Option<bool>,
    /// Hop distance from the anchor (`Hunk::hops`). Present whenever the grow ran with an intent; `None`
    /// under a structural grow, which is what selects the legacy relevance rule below.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hops: Option<i64>,
}

/// Flag the MEMBERS of one seam that a consumer should read first — its spine.
///
/// The structural floor collapses a tangled (god-object / DI-heavy) closure into ONE seam, so seam-level
/// tiering has nothing to separate, and this is what surfaces the path inside the tangle. A seam with fewer
/// than two scored members has nothing to rank.
///
/// HOP-FIRST. This used to rank members by cosine to the intent, taking everything at or above the seam's
/// mean. Measured against what agents actually open (`bench/ranking/`, 9 repo families over keycloak and
/// cal.com), that ranking put 3-6% of read demand in a top-12 while plain hop distance from the anchor put
/// 24-54% — and on keycloak the cosine head was `RevocationModal.tsx` / `ClientSessions.tsx` / `GroupTree
/// .tsx`, none of which any arm opened, while the most-opened file in the corpus sat at rank 18 and the
/// grow's OWN CENTER at 103. Cosine also proved REDUNDANT rather than merely weak: once hops orders the
/// candidates, breaking ties by relevance, tier or citation count gave identical coverage on all 38 keycloak
/// cases. So hops decides, and relevance only settles ties within one hop band.
///
/// DEGRADES TO THE OLD RULE. No intent means no `hops`, and then this is byte-for-byte the relevance
/// behaviour it replaces — an intent ranking must never be a gate on a structurally-correct answer.
pub fn mark_spine_members(hunks: &mut [Member]) {
    let scored: Vec<usize> = (0..hunks.len()).filter(|i| hunks[*i].relevance.is_some()).collect();
    if scored.len() < 2 {
        if scored.len() == 1 {
            hunks[scored[0]].spine = Some(true);
        }
        return;
    }
    let cap = SPINE_MEMBER_CAP.min(1.max((scored.len() + 3) / 4));

    // HOP-FIRST PATH — available only when the grow carried an intent, so `hops` was computed.
    if scored.iter().any(|i| hunks[*i].hops.is_some()) {
        let mut order = scored.clone();
        // hops ASC, then relevance DESC inside a band. A STABLE sort, so equal members keep hunk order and
        // which one wins the last capped slot is decided by position rather than by sort implementation.
        order.sort_by(|a, b| {
            let (ha, hb) = (hunks[*a].hops.unwrap_or(i64::MAX), hunks[*b].hops.unwrap_or(i64::MAX));
            ha.cmp(&hb).then_with(|| {
                hunks[*b]
                    .relevance
                    .unwrap_or(0.0)
                    .partial_cmp(&hunks[*a].relevance.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
        for (n, i) in order.into_iter().enumerate() {
            // An UNREACHED member (`hops` absent while others have it) is not near the anchor — it is not
            // placed at all. It must never outrank a member the graph actually resolved a distance for.
            hunks[i].spine = Some(n < cap && hunks[i].hops.is_some());
        }
        return;
    }

    let sum: f64 = scored.iter().map(|i| hunks[*i].relevance.unwrap_or(0.0)).sum();
    let mean = sum / scored.len() as f64;
    let mut order = scored.clone();
    // relevance DESC. A STABLE sort, so members of equal relevance keep hunk order — the cap makes that
    // observable: which of two equal members gets the last slot is decided by position, not by chance.
    order.sort_by(|a, b| {
        hunks[*b].relevance.unwrap_or(0.0).partial_cmp(&hunks[*a].relevance.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut n = 0usize;
    for i in order {
        let rel = hunks[i].relevance.unwrap_or(0.0);
        let take = rel >= mean && n < cap;
        if rel >= mean {
            n += 1;
        }
        hunks[i].spine = Some(take);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn banded(rels: &[f64]) -> Vec<Banded> {
        rels.iter().map(|r| Banded { relevance: Some(*r), tier: None }).collect()
    }
    fn tiers(b: &[Banded]) -> Vec<&str> {
        b.iter().map(|s| s.tier.as_deref().unwrap_or("-")).collect()
    }

    #[test]
    fn top_third_is_spine_middle_supporting_tail_off() {
        let mut s = banded(&[0.1, 0.9, 0.5, 0.8, 0.2, 0.6]);
        band_tiers(&mut s);
        assert_eq!(tiers(&s), ["off", "spine", "supporting", "spine", "off", "supporting"]);
    }

    #[test]
    fn unscored_seams_are_left_alone_rather_than_banded_off() {
        // an unscored seam is not a LOW-scoring seam — banding it `off` would drop it from a consumer that
        // filters on tier, on the strength of a score that was never computed.
        let mut s = vec![Banded::default(), Banded::default()];
        band_tiers(&mut s);
        assert!(s.iter().all(|x| x.tier.is_none()));
    }

    #[test]
    fn the_off_intent_floor_demotes_a_far_below_top_seam_however_it_ranks() {
        // top 1.0 => floor 0.5; the 0.3 would be `supporting` by raw 3-band rank and is forced off.
        let mut s = banded(&[1.0, 0.95, 0.9, 0.3, 0.2, 0.1, 0.05]);
        band_tiers(&mut s);
        assert_eq!(tiers(&s), ["spine", "spine", "spine", "off", "off", "off", "off"]);
        assert_eq!(s.iter().filter(|x| x.tier.as_deref() == Some("off")).count(), 4);
    }

    #[test]
    fn compressed_scores_keep_the_rank_bands_the_floor_only_crops_a_real_gap() {
        // floor = 0.45, nothing below it — so the bottom band is decided by RANK, not force-dropped
        let mut s = banded(&[0.9, 0.88, 0.86, 0.84, 0.82, 0.8]);
        band_tiers(&mut s);
        assert_eq!(s.iter().filter(|x| x.tier.as_deref() == Some("off")).count(), 2);
    }

    #[test]
    fn a_structural_spine_is_never_rebanded_and_mints_no_more_spine() {
        // when emit already locked the crossing backbone, embeddings only split the REMAINDER two ways —
        // they must not promote a fourth text-similar seam into a spine that structure did not identify.
        let mut s = banded(&[0.9, 0.8, 0.7, 0.6, 0.55]);
        s[0].tier = Some("spine".into());
        band_tiers(&mut s);
        assert_eq!(s[0].tier.as_deref(), Some("spine"));
        assert!(s[1..].iter().all(|x| x.tier.as_deref() != Some("spine")));
        assert_eq!(tiers(&s), ["spine", "supporting", "supporting", "off", "off"]);
    }

    fn members(rels: &[f64]) -> Vec<Member> {
        rels.iter().map(|r| Member { relevance: Some(*r), spine: None, hops: None }).collect()
    }
    fn hopped(rh: &[(i64, f64)]) -> Vec<Member> {
        rh.iter().map(|(h, r)| Member { relevance: Some(*r), spine: None, hops: Some(*h) }).collect()
    }
    fn flagged(m: &[Member]) -> Vec<usize> {
        (0..m.len()).filter(|i| m[*i].spine == Some(true)).collect()
    }

    #[test]
    fn hops_decide_the_spine_and_cosine_does_not_get_a_vote_across_bands() {
        // The measured failure in one case: the cosine favourite is FAR from the anchor and the near members
        // score poorly. Ranking by relevance would take index 0; hop-first must take the near ones.
        let mut h = hopped(&[(5, 0.99), (1, 0.10), (2, 0.11), (1, 0.20)]);
        mark_spine_members(&mut h);
        // cap = min(12, max(1, (4+3)/4)) = 1 -> only the nearest member survives, and among the two at hop 1
        // it is the higher-relevance one, because relevance breaks ties INSIDE a band.
        assert_eq!(flagged(&h), [3]);
    }

    #[test]
    fn relevance_still_orders_within_one_hop_band() {
        let mut h = hopped(&[(2, 0.10), (2, 0.90), (2, 0.50), (2, 0.70), (2, 0.60), (2, 0.20), (2, 0.30), (2, 0.40)]);
        mark_spine_members(&mut h);
        // cap = min(12, max(1, 11/4)) = 2 -> the two highest-relevance members of the single band
        assert_eq!(flagged(&h), [1, 3]);
    }

    #[test]
    fn an_unreached_member_never_outranks_a_placed_one() {
        // `hops: None` beside members that HAVE a distance means the graph resolved no path to it. It must
        // sort last and must not be flagged, or an unplaced node takes a capped slot from a real one.
        let mut h = vec![
            Member { relevance: Some(0.99), spine: None, hops: None },
            Member { relevance: Some(0.10), spine: None, hops: Some(3) },
        ];
        mark_spine_members(&mut h);
        assert_eq!(flagged(&h), [1]);
        assert_eq!(h[0].spine, Some(false));
    }

    #[test]
    fn without_hops_it_is_byte_for_byte_the_relevance_rule() {
        // The degradation contract: a structural grow carries no `hops`, and must rank exactly as before.
        let mut a = members(&[0.34, 0.31, 0.28, 0.02, 0.03]);
        let mut b = members(&[0.34, 0.31, 0.28, 0.02, 0.03]);
        mark_spine_members(&mut a);
        // the pre-change rule, inlined, as the oracle
        let mean: f64 = 0.98 / 5.0;
        let cap = 12usize.min(1.max((5 + 3) / 4));
        let mut order: Vec<usize> = (0..5).collect();
        order.sort_by(|x, y| b[*y].relevance.unwrap().partial_cmp(&b[*x].relevance.unwrap()).unwrap());
        let mut n = 0;
        for i in order {
            let rel = b[i].relevance.unwrap();
            let take = rel >= mean && n < cap;
            if rel >= mean { n += 1; }
            b[i].spine = Some(take);
        }
        assert_eq!(a.iter().map(|m| m.spine).collect::<Vec<_>>(), b.iter().map(|m| m.spine).collect::<Vec<_>>());
    }

    #[test]
    fn top_above_average_members_are_flagged_and_the_noise_tail_is_not() {
        let mut h = members(&[0.34, 0.31, 0.28]);
        h.extend((0..20).map(|i| Member { relevance: Some(0.02 + i as f64 * 0.001), spine: None, hops: None }));
        mark_spine_members(&mut h);
        let flagged: Vec<usize> = (0..h.len()).filter(|i| h[*i].spine == Some(true)).collect();
        assert_eq!(flagged, [0, 1, 2]);
        assert_eq!(h[3].spine, Some(false));
    }

    #[test]
    fn the_cap_holds_at_twelve_even_when_thirty_members_beat_the_mean() {
        // cap = min(12, ceil(60/4)=15) = 12. "The path" through a tangle is a handful, not a top third.
        let mut h: Vec<Member> =
            (0..60).map(|i| Member { relevance: Some(if i < 30 { 0.9 } else { 0.1 }), spine: None, hops: None }).collect();
        mark_spine_members(&mut h);
        assert_eq!(h.iter().filter(|x| x.spine == Some(true)).count(), 12);
        // and it is the FIRST twelve of the equal-scoring block — a stable sort, so which members win the
        // last slots is decided by hunk order, not by sort implementation
        assert!(h[..12].iter().all(|x| x.spine == Some(true)));
    }

    #[test]
    fn unscored_members_are_ignored_and_a_lone_scored_member_is_the_spine() {
        // summary/caller hunks ("+3 more") carry no relevance; they must not be flagged, and they must not
        // stop the one real member from being the path.
        let mut h = vec![Member { relevance: Some(0.2), spine: None, hops: None }, Member::default()];
        mark_spine_members(&mut h);
        assert_eq!(h[0].spine, Some(true));
        assert_eq!(h[1].spine, None);
    }
}
