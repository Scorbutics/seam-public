"""Tests for the fuzzy-entry anchor ranking (src/anchor_rank.py)."""
from src import anchor_rank


CANDS = [
    {"name": "getScoringConfig", "file": "packages/features/scoring/config.ts", "kind": "function"},
    {"name": "ScoreService", "file": "packages/features/scoring/score.service.ts", "kind": "class"},
    {"name": "renderAvatar", "file": "packages/ui/avatar.tsx", "kind": "function"},
    {"name": "tmp", "file": "lib/scoring/util.ts", "kind": "variable"},
]


def test_tokenize_splits_camel_and_path():
    assert anchor_rank._tokens("getScoringConfig") == ["get", "scoring", "config"]
    assert anchor_rank._tokens("score.service.ts") == ["score", "service", "ts"]
    assert "scoring" in anchor_rank._tokens("features/scoring/config")


def test_stopwords_dropped_from_intent():
    # a full sentence reduces to the content word(s)
    assert anchor_rank._content_words("how does scoring work") == {"scoring"}


def test_ranks_relevant_anchor_first_and_drops_unrelated():
    ranked = anchor_rank.rank_anchors("how does scoring work", CANDS)
    names = [c["name"] for c in ranked]
    # the scoring symbols rank above the avatar one
    assert names[0] in ("getScoringConfig", "ScoreService")
    assert "renderAvatar" not in names                 # no content-word overlap → dropped
    # name match beats path-only match (getScoringConfig has 'scoring' in the NAME)
    assert names.index("getScoringConfig") < names.index("tmp")
    # the matched term is surfaced for the UI
    assert ranked[0]["terms"] == ["scoring"] or "scoring" in ranked[0]["terms"]


def test_kind_boost_breaks_ties():
    # same name-overlap (none) but path 'scoring' for both; class outranks variable via kind boost
    cands = [
        {"name": "helper", "file": "scoring/a.ts", "kind": "variable"},
        {"name": "widget", "file": "scoring/b.ts", "kind": "class"},
    ]
    ranked = anchor_rank.rank_anchors("scoring", cands)
    assert ranked[0]["name"] == "widget"


def test_no_match_returns_something_to_pick():
    # zero overlap → don't return empty (the user still gets candidates to choose from)
    ranked = anchor_rank.rank_anchors("zzzznomatch", CANDS)
    assert len(ranked) == len(CANDS)
