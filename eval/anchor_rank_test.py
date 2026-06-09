"""Tests for the fuzzy-entry anchor ranking (src/anchor_rank.py)."""
import os

from src import anchor_rank

REPO = os.path.join(os.path.dirname(__file__), "fixtures", "scan_repo")


CANDS = [
    {"name": "getScoringConfig", "file": "packages/features/scoring/config.ts", "kind": "function"},
    {"name": "ScoreService", "file": "packages/features/scoring/score.service.ts", "kind": "class"},
    {"name": "renderAvatar", "file": "packages/ui/avatar.tsx", "kind": "function"},
    {"name": "scores", "file": "x/handler.ts", "kind": "symbol"},        # a local var/const → noise
    {"name": "userScores", "file": "y/svc.ts", "kind": "field"},          # a field → noise
]


def test_tokenize_splits_camel_and_path():
    assert anchor_rank._tokens("getScoringConfig") == ["get", "scoring", "config"]
    assert anchor_rank._tokens("score.service.ts") == ["score", "service", "ts"]
    assert "scoring" in anchor_rank._tokens("features/scoring/config")


def test_stem_singularises():
    assert anchor_rank._stem("roles") == "role"
    assert anchor_rank._stem("classes") == "class"
    assert anchor_rank._stem("repositories") == "repository"
    assert anchor_rank._stem("save") == "save"        # untouched


def test_stopwords_dropped_from_intent():
    assert anchor_rank._content_words("how does scoring work") == {"scoring"}


def test_filters_local_var_and_field_noise():
    ranked = anchor_rank.rank_anchors("how does scoring work", CANDS)
    names = {c["name"] for c in ranked}
    assert "scores" not in names and "userScores" not in names   # symbol/field kinds dropped
    assert "getScoringConfig" in names                            # function kept


def test_plural_intent_matches_singular_anchor():
    # "how are roles saved" must surface RoleService (role ⊂ RoleService) despite the plural, and
    # drop the `roles` local var
    cands = [
        {"name": "RoleService", "file": "pbac/services/role.service.ts", "kind": "class"},
        {"name": "roles", "file": "x/list.handler.ts", "kind": "symbol"},
        {"name": "userRoles", "file": "y/remove.ts", "kind": "field"},
    ]
    ranked = anchor_rank.rank_anchors("how are roles saved", cands)
    assert ranked[0]["name"] == "RoleService"
    assert {c["name"] for c in ranked} == {"RoleService"}          # the noise is filtered out
    assert "roles" in ranked[0]["terms"]                          # the matched word surfaced


def test_ranks_relevant_first_and_drops_unrelated():
    ranked = anchor_rank.rank_anchors("how does scoring work", CANDS)
    names = [c["name"] for c in ranked]
    assert names[0] in ("getScoringConfig", "ScoreService")
    assert "renderAvatar" not in names                            # anchor kind but no overlap → dropped


def test_kind_boost_breaks_ties_among_anchors():
    # both anchor kinds, both match only on path 'scoring'; class outranks function via kind boost
    cands = [
        {"name": "helper", "file": "scoring/a.ts", "kind": "function"},
        {"name": "widget", "file": "scoring/b.ts", "kind": "class"},
    ]
    ranked = anchor_rank.rank_anchors("scoring", cands)
    assert ranked[0]["name"] == "widget"


def test_no_match_returns_the_anchor_pool():
    # zero overlap → still return the ANCHOR-kind candidates (not the noise, not empty)
    ranked = anchor_rank.rank_anchors("zzzznomatch", CANDS)
    names = {c["name"] for c in ranked}
    assert names == {"getScoringConfig", "ScoreService", "renderAvatar"}


def test_find_anchor_candidates_deterministic_scan():
    # discovery is a repo scan (no language server): top-level decls whose name shares the keyword stem
    cands = anchor_rank.find_anchor_candidates(REPO, ["payment"])
    assert any(c["name"] == "PaymentService" and c["kind"] == "class" for c in cands)


def test_find_anchor_candidates_keyword_filtered_no_plain_const():
    cands = anchor_rank.find_anchor_candidates(REPO, ["widget"])
    names = {c["name"] for c in cands}
    assert "makeWidget" in names           # `export function makeWidget` — a real anchor decl
    assert "WIDGET_KIND" not in names      # a plain (non-arrow) const is not an anchor decl
    assert "PaymentService" not in names   # no 'widget' stem → not discovered


def test_suggest_crossings_interface_to_impl():
    # P4: a boundary at the interface `IPaymentGateway` → its in-repo implementations (symbol match)
    cr = anchor_rank.suggest_crossings(REPO, "IPaymentGateway")
    names = {c["name"] for c in cr}
    assert "PaymentGateway" in names and "StripePaymentGateway" in names
    assert "IPaymentGateway" not in names                 # never itself
    assert all(c["kind"] == "class" for c in cr)          # behavioural impls
