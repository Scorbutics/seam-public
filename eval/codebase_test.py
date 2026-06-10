"""Codebase-mode gate — pins the anchor-relative decomposition (plan §3) END-TO-END.

The SymbolResolver front (VSCode language APIs) can only be validated in the extension
host (F5). Everything DOWNSTREAM of its JSON contract — ingestion, role BFS, clustering,
well-formedness, emit — is pure and pinned here against a hand-built `ResolvedGraph`
fixture, so the engine is provable without the editor:

    .venv/bin/python -m pytest eval/codebase_test.py -q

What it locks:
  - the §1 invariant survives ingestion: SUGGESTED candidates stay OUT of `edges`;
    `unresolved` (UNKNOWN ≠ []) is preserved, never read as "no link".
  - anchor-relative roles: anchor + its members → core; boundary node → link; depth-2 →
    environment; test node → test.
  - well-formedness over RESOLVED edges only: the DI-wired member is an isolated-core
    (a TRUE shadow surfaced honestly, with its blind spot).
  - emit drops nothing: every reached node lands in a seam (cores or ambient ripple).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src.codebase import atoms as atoms_mod
from src.codebase import codebase
from src.core import graph_ir
from src.core.graph_ir import Provenance, assert_resolved_only  # noqa: E402

# A component shaped like cal.com's AssignmentWarningDialog: one core, two handlers that split
# on distinctive props (id vs pendingRoute/leaveWithoutAssigningHosts), sharing ambient glue.
_COMPONENT_TSX = """export const AssignmentWarningDialog = (props: P) => {
  const { t } = useLocale();
  const { isOpen, setIsOpen, pendingRoute, leaveWithoutAssigningHosts, id } = props;
  const router = useRouter();
  return (
    <Dialog open={isOpen}>
      <Button onClick={(e) => { e.preventDefault(); setIsOpen(false); router.replace(`/x/${id}?t=team`); }}>go</Button>
      <Button onClick={(e) => { e.preventDefault(); setIsOpen(false); leaveWithoutAssigningHosts.current = true; router.replace(pendingRoute); }}>leave</Button>
    </Dialog>
  );
};
"""
_requires_ts = pytest.mark.skipif(not atoms_mod.available(), reason="tree-sitter not installed")

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "resolved-graph-sample.json"


@pytest.fixture
def g() -> graph_ir.Graph:
    return graph_ir.from_resolved_graph(json.loads(FIXTURE.read_text(encoding="utf-8")))


# --------------------------------------------------------------------------- ingestion / invariant
def test_ingestion_keeps_suggested_out_of_edges(g):
    assert all(e.provenance.is_resolved for e in g.edges)        # edges[] is resolved-only
    assert_resolved_only(g.edges)                                # the spine holds
    # the DI candidate is a blind spot, NEVER a resolved edge.
    assert g.blindspots and g.blindspots[0].mechanism == "DI"
    assert all(c.provenance is Provenance.SUGGESTED for c in g.blindspots[0].candidates)
    assert all(e.dst != "StripeGateway" for e in g.edges)        # not minted as an edge


def test_unknown_is_not_empty(g):
    # an unresolved query is recorded as UNKNOWN, distinct from "no link".
    assert g.unresolved and g.unresolved[0]["node"] == "n8"
    assert g.anchor == "n1" and g.resolution_quality == "FULL"


# --------------------------------------------------------------------------- roles (Layer 3)
def test_anchor_relative_roles(g):
    codebase.assign_roles(g)
    role = {n.id: n.role for n in g.nodes.values()}
    assert role["n1"] == "core"            # anchor
    assert role["n2"] == role["n3"] == role["n8"] == "core"   # its members
    assert role["n4"] == "link"            # boundary node wired to cores
    assert role["n6"] == "environment"     # depth-2, reached only via the link
    assert role["n7"] == "test"            # verification node


# --------------------------------------------------------------------------- mark-relevance (F5)
def test_mark_relevance_dims_incidental_links(g, monkeypatch):
    codebase.assign_roles(g)               # n4 = link, n1 = core
    monkeypatch.setattr(codebase.llm, "run_pass", lambda *a, **k: {"n4": {"relevant": False}})
    codebase.mark_relevance_llm(g, "how does the anchor persist data?")
    assert g.nodes["n4"].relevant is False         # incidental link → dimmed (kept, not dropped)
    assert g.nodes["n1"].relevant is True          # a core is the focus → always relevant
    assert g.nodes["n4"].id in {n.id for n in g.nodes.values()}   # still present


def test_mark_relevance_degrades_to_all_relevant(g, monkeypatch):
    codebase.assign_roles(g)
    def boom(*a, **k):
        raise codebase.llm.LLMError("no backend")
    monkeypatch.setattr(codebase.llm, "run_pass", boom)
    codebase.mark_relevance_llm(g, "q")
    assert all(n.relevant for n in g.nodes.values())   # nothing dimmed on LLM failure (honest default)


# --------------------------------------------------------------------------- seam contracts (inter-seam)
def test_seam_contracts_finds_bridging_symbol_and_blurriness():
    # a consumer `C` uses methods that live in TWO seams → it BRIDGES them; the edges are heuristic
    # (RESOLVED_PARTIAL) → the contract is BLURRY. Containment (m→Svc) and the anchor are excluded.
    g = graph_ir.from_resolved_graph({
        "anchor": {"id": "A"}, "anchors": ["A"],
        "nodes": [{"id": "A", "symbol": "Svc"}, {"id": "m1", "symbol": "create", "enclosing": "Svc"},
                  {"id": "m2", "symbol": "remove", "enclosing": "Svc"}, {"id": "C", "symbol": "router"}],
        "edges": [{"from": "m1", "to": "A", "kind": "contains", "provenance": "RESOLVED_FULL"},
                  {"from": "m2", "to": "A", "kind": "contains", "provenance": "RESOLVED_FULL"},
                  {"from": "C", "to": "m1", "kind": "reference", "provenance": "RESOLVED_PARTIAL"},
                  {"from": "C", "to": "m2", "kind": "reference", "provenance": "RESOLVED_PARTIAL"}],
    })
    seams = [{"id": "s1", "label": "Create", "node_ids": ["A", "m1", "C"]},
             {"id": "s2", "label": "Remove", "node_ids": ["A", "m2", "C"]}]
    cs = codebase._seam_contracts(g, seams)
    assert len(cs) == 1
    c = cs[0]
    assert {c["seamA"], c["seamB"]} == {"s1", "s2"}
    assert c["blurry"] is True                          # bridged only by heuristic edges
    bridged = {(l["from"], l["to"]) for l in c["links"]}
    assert ("C", "m1") in bridged and ("C", "m2") in bridged
    assert all(l["kind"] != "contains" for l in c["links"])   # containment is structure, not a contract


# --------------------------------------------------------------------------- well-formedness (Layer 6)
def test_isolated_core_is_surfaced(g):
    codebase.assign_roles(g)
    health = graph_ir.wellformedness(g)
    # n8 (DI-wired) has no resolved link → an honest isolated-core shadow.
    assert "isolated-core" in health["seam_warnings"].get("n8", [])
    assert health["postures"]["isolated_cores"] == 1
    assert health["postures"]["unresolved"] == 1
    assert health["postures"]["blindspots"] == 1


def test_wellformedness_rejects_non_resolved_edges(g):
    codebase.assign_roles(g)
    g.edges.append(graph_ir.Edge("n2", "n6", provenance=Provenance.LLM))
    with pytest.raises(graph_ir.ResolvedOnlyViolation):
        graph_ir.wellformedness(g)         # an LLM edge must never reach the resolved op


# --------------------------------------------------------------------------- emit (end-to-end)
def test_emit_drops_no_reached_node(g):
    model = codebase.decompose(g)
    rendered = {h["id"] for cl in model["clusters"] for s in cl["seams"] for h in s["hunks"]}
    rendered |= {h["id"] for h in model["tests"]}
    assert rendered == set(g.nodes)        # nothing reached is silently dropped

    assert model["mode"] == "codebase"
    assert model["resolutionQuality"] == "FULL"
    assert model["anchor"] == "n1"
    assert model["blindspots"][0]["mechanism"] == "DI"
    # the anchor + members cluster together (containment edges), n4/n6 join via calls.
    assert len(model["clusters"]) == 1
    # the isolated-core warning rides on n8's seam.
    n8_seam = next(s for cl in model["clusters"] for s in cl["seams"] if s["id"] == "n8")
    assert "isolated-core" in n8_seam["warnings"]


# --------------------------------------------------------------------------- Model B (sub-cores)
@_requires_ts
def test_extract_atoms_finds_nested_handlers():
    last = _COMPONENT_TSX.rstrip().count("\n")
    atoms = atoms_mod.extract_atoms(_COMPONENT_TSX, "tsx", 0, last)
    assert len(atoms) == 2                                  # the two onClick handlers
    names = [a.names for a in atoms]
    assert any("id" in n for n in names)
    assert any("pendingRoute" in n and "leaveWithoutAssigningHosts" in n for n in names)


@_requires_ts
def test_subcores_split_component_by_behaviour(tmp_path):
    """The verified atoms (handler ranges) are RESOLVED; the PROPOSED grouping splits them into
    two behavioural sub-cores on their distinctive props, sharing the ambient setIsOpen/router."""
    last = _COMPONENT_TSX.rstrip().count("\n")
    (tmp_path / "AssignmentWarningDialog.tsx").write_text(_COMPONENT_TSX, encoding="utf-8")
    g = graph_ir.from_resolved_graph({
        "version": 1,
        "anchor": {"id": "a", "symbol": "AssignmentWarningDialog",
                   "file": "AssignmentWarningDialog.tsx", "range": [0, last]},
        "language": "typescriptreact", "resolutionQuality": "FULL", "depth": 2, "complete": True,
        "nodes": [{"id": "a", "symbol": "AssignmentWarningDialog", "kind": "function",
                   "file": "AssignmentWarningDialog.tsx", "range": [0, last], "enclosing": "", "complexity": last}],
        "edges": [], "blindspots": [], "unresolved": [],
    })
    model = codebase.decompose(g, repo=str(tmp_path))
    core = model["clusters"][0]["seams"][0]["hunks"][0]
    assert core["id"] == "a"
    subs = core["subcores"]
    assert len(subs) == 2
    assert all(s["proposed"] for s in subs)                # the partition is flagged PROPOSED
    reads = [set(s["reads"]) for s in subs]
    assert any("id" in r and "pendingRoute" not in r for r in reads)
    assert any("pendingRoute" in r and "leaveWithoutAssigningHosts" in r for r in reads)
    # the boundaries are real code regions (RESOLVED), within the anchor.
    for s in subs:
        for lo, hi in s["ranges"]:
            assert 0 <= lo <= hi <= last


# --------------------------------------------------------------------------- per-language substrate (F1)
_CPP_FN = """int process(int count, void (*callback)(int), const char* label) {
  for (int i = 0; i < count; i++) {
    callback(i);
  }
  log(label);
  return count;
}
"""
_JAVA_FN = """class Svc {
  public int run(int count, String label) {
    System.out.println(label);
    return count;
  }
}
"""


@_requires_ts
def test_contract_cpp_params_and_callback_link():
    """C++ params extracted via the node-kind registry (param list under function_declarator, body
    is compound_statement) — and an INVOKED function-pointer param reads as a callback LINK."""
    last = _CPP_FN.rstrip().count("\n")
    m = {x.name: x for x in atoms_mod.extract_contract(_CPP_FN, "cpp", 0, last)}
    assert "callback" in m and m["callback"].invoked is True        # fn-pointer param, called → link
    assert "count" in m and m["count"].invoked is False             # data
    assert "label" in m and m["label"].invoked is False


@_requires_ts
def test_atoms_cpp_finds_nested_lambda():
    """B atoms are language-parametric too: a C++ nested lambda is a behavioural unit (where a
    classic function has one). Confirms _FUNCLIKE/_BODY cover C++ (compound_statement body)."""
    src = "void run() {\n  auto cb = [](int x){ return x + 1; };\n  apply(cb);\n}\n"
    atoms = atoms_mod.extract_atoms(src, "cpp", 0, src.rstrip().count("\n"))
    assert len(atoms) >= 1


@_requires_ts
def test_contract_java_params_extracted():
    """Java params extracted via the registry (formal_parameter), confirming the substrate is
    language-parametric, not TSX-only."""
    last = _JAVA_FN.rstrip().count("\n")
    names = {x.name for x in atoms_mod.extract_contract(_JAVA_FN, "java", 0, last)}
    assert "count" in names and "label" in names


# --------------------------------------------------------------------------- Model A (contract)
_DELETE_DIALOG_TSX = """export function DeleteDialog({
  isManagedEvent,
  eventTypeId,
  open,
  onOpenChange,
  onDelete,
  isDeleting,
}: Props) {
  const { t } = useLocale();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Content isPending={isDeleting} title={t(`deletes${isManagedEvent}`)}
        onConfirm={(e) => { e.preventDefault(); onDelete(eventTypeId); }} />
    </Dialog>
  );
}
"""


@_requires_ts
def test_contract_marks_invoked_prop_as_link():
    last = _DELETE_DIALOG_TSX.rstrip().count("\n")
    members = atoms_mod.extract_contract(_DELETE_DIALOG_TSX, "tsx", 0, last)
    by = {m.name: m for m in members}
    assert by["onDelete"].invoked is True                   # called in the body → a behavioural link
    assert by["open"].invoked is False and by["isDeleting"].invoked is False   # read-only data
    assert by["onDelete"].ranges                            # has an internal-use range


@_requires_ts
def test_contract_emitted_as_link_and_environment(tmp_path):
    last = _DELETE_DIALOG_TSX.rstrip().count("\n")
    (tmp_path / "DeleteDialog.tsx").write_text(_DELETE_DIALOG_TSX, encoding="utf-8")
    g = graph_ir.from_resolved_graph({
        "version": 1,
        "anchor": {"id": "a", "symbol": "DeleteDialog", "file": "DeleteDialog.tsx", "range": [0, last]},
        "language": "typescriptreact", "resolutionQuality": "FULL", "depth": 2, "complete": True,
        "nodes": [{"id": "a", "symbol": "DeleteDialog", "kind": "function",
                   "file": "DeleteDialog.tsx", "range": [0, last], "enclosing": "", "complexity": last}],
        "edges": [], "blindspots": [], "unresolved": [],
    })
    model = codebase.decompose(g, repo=str(tmp_path))
    core = model["clusters"][0]["seams"][0]["hunks"][0]
    contract = {c["name"]: c for c in core["contract"]}
    assert contract["onDelete"]["role"] == "link"          # the invoked callback is a link
    assert contract["open"]["role"] == "environment"       # passive data
    assert contract["onDelete"]["ranges"]


@_requires_ts
def test_consumer_feed_completes_the_prop_thread(tmp_path):
    """A2: the contract member's thread is completed with WHO FEEDS it — the value a consumer
    passes to that prop, parsed from the consumer's <Anchor …/> usage."""
    last = _DELETE_DIALOG_TSX.rstrip().count("\n")
    (tmp_path / "DeleteDialog.tsx").write_text(_DELETE_DIALOG_TSX, encoding="utf-8")
    (tmp_path / "Layout.tsx").write_text(
        "export function Layout() {\n"
        "  return (\n"
        "    <DeleteDialog eventTypeId={eventType.id} open={deleteOpen} onDelete={onDelete} />\n"
        "  );\n}\n", encoding="utf-8")
    g = graph_ir.from_resolved_graph({
        "version": 1,
        "anchor": {"id": "a", "symbol": "DeleteDialog", "file": "DeleteDialog.tsx", "range": [0, last]},
        "language": "typescriptreact", "resolutionQuality": "FULL", "depth": 2, "complete": True,
        "nodes": [
            {"id": "a", "symbol": "DeleteDialog", "kind": "function", "file": "DeleteDialog.tsx", "range": [0, last], "enclosing": "", "complexity": last},
            {"id": "c", "symbol": "Layout", "kind": "function", "file": "Layout.tsx", "range": [0, 4], "enclosing": "", "complexity": 4},
        ],
        "edges": [{"from": "c", "to": "a", "kind": "reference", "provenance": "RESOLVED_FULL"}],
        "blindspots": [], "unresolved": [],
    })
    model = codebase.decompose(g, repo=str(tmp_path))
    core = next(h for cl in model["clusters"] for s in cl["seams"] for h in s["hunks"] if h["id"] == "a")
    contract = {c["name"]: c for c in core["contract"]}
    feeds = contract["onDelete"].get("feeds", [])
    assert feeds and feeds[0]["value"] == "onDelete" and feeds[0]["from"] == "Layout.tsx"
    assert contract["eventTypeId"]["feeds"][0]["value"] == "eventType.id"
    # A3: the feed carries the value's precise position so the extension can resolve its def.
    assert feeds[0]["valLine"] >= 0 and feeds[0]["valCol"] >= 0


def test_subcores_inert_without_repo():
    # no repo to read source → no proposed partition (contract stays lean; B degrades to A).
    g = graph_ir.from_resolved_graph(json.loads(FIXTURE.read_text(encoding="utf-8")))
    model = codebase.decompose(g)
    assert all("subcores" not in h
               for cl in model["clusters"] for s in cl["seams"] for h in s["hunks"])


def test_no_subcores_for_class_anchor(tmp_path):
    # a class is already decomposed into method cores — it must NOT also be sub-cored.
    g = graph_ir.from_resolved_graph(json.loads(FIXTURE.read_text(encoding="utf-8")))  # PaymentService class
    model = codebase.decompose(g, repo=str(tmp_path))
    assert all("subcores" not in h
               for cl in model["clusters"] for s in cl["seams"] for h in s["hunks"])


# --------------------------------------------------------------------------- F4: LLM refine
def _svc_graph():
    """Anchor Svc (class) with methods m1,m2,m3; c1 uses m1+m2, c2 uses m3. Floor co-occurrence →
    {m1,m2},{m3}."""
    return graph_ir.from_resolved_graph({
        "version": 1, "anchor": {"id": "a", "symbol": "Svc", "file": "svc.ts", "range": [0, 40]},
        "language": "typescript", "resolutionQuality": "FULL", "depth": 2, "complete": True,
        "nodes": [
            {"id": "a", "symbol": "Svc", "kind": "class", "file": "svc.ts", "range": [0, 40], "enclosing": "", "complexity": 40},
            {"id": "m1", "symbol": "m1", "kind": "method", "file": "svc.ts", "range": [2, 8], "enclosing": "Svc", "complexity": 6},
            {"id": "m2", "symbol": "m2", "kind": "method", "file": "svc.ts", "range": [10, 16], "enclosing": "Svc", "complexity": 7},
            {"id": "m3", "symbol": "m3", "kind": "method", "file": "svc.ts", "range": [18, 24], "enclosing": "Svc", "complexity": 9},
            {"id": "c1", "symbol": "C1", "kind": "function", "file": "x/C1.ts", "range": [0, 5], "enclosing": "", "complexity": 5},
            {"id": "c2", "symbol": "C2", "kind": "function", "file": "y/C2.ts", "range": [0, 5], "enclosing": "", "complexity": 5},
        ],
        "edges": [
            {"from": "c1", "to": "m1", "kind": "call", "provenance": "RESOLVED_FULL"},
            {"from": "c1", "to": "m2", "kind": "call", "provenance": "RESOLVED_FULL"},
            {"from": "c2", "to": "m3", "kind": "call", "provenance": "RESOLVED_FULL"},
        ],
        "blindspots": [], "unresolved": [],
    })


def test_llm_refine_overrides_floor_grouping(monkeypatch):
    """The LLM REFINES the floor: here it regroups (m1 alone; m2+m3 together) and names — a
    PROPOSED partition over the verified carriers, marked proposedBy=llm."""
    monkeypatch.setattr(codebase.llm, "run_pass",
                        lambda *a, **k: {"m1": {"seam": "S1", "label": "alpha"},
                                         "m2": {"seam": "S2", "label": "beta"},
                                         "m3": {"seam": "S2"}})
    model = codebase.decompose(_svc_graph(), use_llm=True)
    sm = _seams_of(model)
    assert sm["m2"] == sm["m3"] and sm["m1"] != sm["m2"]    # LLM's grouping, not the floor's
    seams = {s["id"]: s for cl in model["clusters"] for s in cl["seams"]}
    assert all(s["proposedBy"] == "llm" for s in seams.values())
    labels = {s["label"] for s in seams.values()}
    assert "alpha" in labels and "beta" in labels


def test_llm_refine_falls_back_to_floor_on_error(monkeypatch):
    """No LLM (or a failure) → the deterministic floor stands; never a crash, never empty."""
    def boom(*a, **k):
        raise codebase.llm.LLMError("no backend")
    monkeypatch.setattr(codebase.llm, "run_pass", boom)
    model = codebase.decompose(_svc_graph(), use_llm=True)
    sm = _seams_of(model)
    assert sm["m1"] == sm["m2"] and sm["m3"] != sm["m1"]    # the FLOOR co-occurrence grouping
    assert all(s["proposedBy"] == "floor" for cl in model["clusters"] for s in cl["seams"])


def test_llm_refine_cannot_invent_carriers(monkeypatch):
    """An id the LLM returns that is NOT a real member is dropped — the partition groups verified
    carriers only; it can mis-frame but never fabricate a node."""
    monkeypatch.setattr(codebase.llm, "run_pass",
                        lambda *a, **k: {"m1": {"seam": "S1"}, "m2": {"seam": "S1"},
                                         "m3": {"seam": "S2"}, "ghost": {"seam": "S9", "label": "junk"}})
    model = codebase.decompose(_svc_graph(), use_llm=True)
    ids = {h["id"] for cl in model["clusters"] for s in cl["seams"] for h in s["hunks"]}
    assert "ghost" not in ids
    labels = {s["label"] for cl in model["clusters"] for s in cl["seams"]}
    assert "junk" not in labels


def test_intent_fused_selection_marks_seam(monkeypatch):
    """P1: with an intent, the SAME refine pass also marks the matching seam (`match`) → the model
    carries `selectedSeam` + the seam's `selected` flag (focus). Fused: one pass groups AND selects."""
    monkeypatch.setattr(codebase.llm, "run_pass",
                        lambda *a, **k: {"m1": {"seam": "S1", "label": "alpha"},
                                         "m2": {"seam": "S2", "label": "beta", "match": True},
                                         "m3": {"seam": "S2", "match": True}})
    model = codebase.decompose(_svc_graph(), use_llm=True, intent="how does beta work")
    sel = model["selectedSeam"]
    assert sel
    seams = {s["id"]: s for cl in model["clusters"] for s in cl["seams"]}
    assert seams[sel]["selected"] is True
    assert sum(1 for s in seams.values() if s.get("selected")) == 1     # exactly one focus
    assert {"m2", "m3"} <= {h["id"] for h in seams[sel]["hunks"]}        # the matched members


def test_no_intent_leaves_no_selection(monkeypatch):
    """No intent → the refine pass omits the selection ask → no seam is focused (unchanged path)."""
    monkeypatch.setattr(codebase.llm, "run_pass",
                        lambda *a, **k: {"m1": {"seam": "S1"}, "m2": {"seam": "S2"}, "m3": {"seam": "S2"}})
    model = codebase.decompose(_svc_graph(), use_llm=True)
    assert model["selectedSeam"] == ""
    assert not any(s.get("selected") for cl in model["clusters"] for s in cl["seams"])


def test_intent_degrades_to_floor_with_no_selection(monkeypatch):
    """Intent given but the LLM fails → the deterministic floor stands and nothing is focused."""
    def boom(*a, **k):
        raise codebase.llm.LLMError("no backend")
    monkeypatch.setattr(codebase.llm, "run_pass", boom)
    model = codebase.decompose(_svc_graph(), use_llm=True, intent="how are roles saved")
    assert model["selectedSeam"] == ""


# --------------------------------------------------------------------------- seam grain (Layer 4)
def _seams_of(model):
    """{node_id: frozenset(seam ids it appears in)} — a node may be in several seams (many-to-many)."""
    out: dict = {}
    for cl in model["clusters"]:
        for s in cl["seams"]:
            for h in s["hunks"]:
                out.setdefault(h["id"], set()).add(s["id"])
    return {k: frozenset(v) for k, v in out.items()}


def test_floor_cooccurrence_groups_carriers_shared_core_many_to_many(g):
    """F2 floor: charge + refund co-occur via the gateway consumer → ONE intent-seam; validate
    (used by no one) stays its OWN seam; the anchor CLASS appears in BOTH (many-to-many)."""
    model = codebase.decompose(g)
    sm = _seams_of(model)
    assert sm["n2"] == sm["n3"]                        # charge + refund co-occur → same seam
    assert sm["n8"] != sm["n2"]                        # validate → its own seam
    assert len(sm["n1"]) >= 2                          # the anchor core is shared across seams
    n8_seam = next(s for cl in model["clusters"] for s in cl["seams"]
                   if "n8" in {h["id"] for h in s["hunks"]})
    assert "isolated-core" in n8_seam["warnings"]      # validate seam = honest isolated-core


# --------------------------------------------------------------------------- Layer 2 (blind spots)
def test_dynamic_import_surfaced_as_suggested_blindspot(tmp_path):
    """A consumer that loads the anchor via a string-path dynamic import is INVISIBLE to the
    reference resolver (a false isolated-core). Layer 2 detects the mechanism and surfaces it
    as a SUGGESTED blind spot — never a resolved edge (invariant §1)."""
    (tmp_path / "dialogs").mkdir()
    (tmp_path / "dialogs" / "AssignmentWarningDialog.tsx").write_text(
        "export const AssignmentWarningDialog = () => null;\n", encoding="utf-8")
    (tmp_path / "EventTypeWebWrapper.tsx").write_text(
        'const AssignmentWarningDialog = dynamic(() => import("./dialogs/AssignmentWarningDialog"));\n',
        encoding="utf-8")
    # the resolved graph: anchor only, NO links (find-references saw nothing — the dynamic
    # load is opaque). This is the dangerous "used nowhere" shape we must qualify.
    data = {
        "version": 1,
        "anchor": {"id": "a", "symbol": "AssignmentWarningDialog",
                   "file": "dialogs/AssignmentWarningDialog.tsx", "range": [1, 1]},
        "language": "typescriptreact", "resolutionQuality": "FULL", "depth": 2, "complete": True,
        "nodes": [{"id": "a", "symbol": "AssignmentWarningDialog", "kind": "function",
                   "file": "dialogs/AssignmentWarningDialog.tsx", "range": [1, 1], "enclosing": "", "complexity": 1}],
        "edges": [], "blindspots": [], "unresolved": [],
    }
    g = graph_ir.from_resolved_graph(data)
    model = codebase.decompose(g, repo=str(tmp_path))

    assert g.edges == []                                   # NO resolved edge minted
    bs = model["blindspots"]
    assert len(bs) == 1 and bs[0]["mechanism"] == "dynamic-import" and bs[0]["node"] == "a"
    assert all(c["provenance"] == "SUGGESTED" for c in bs[0]["candidates"])
    assert any("EventTypeWebWrapper.tsx" in c["symbol"] for c in bs[0]["candidates"])


def test_no_blindspot_without_repo():
    # without a repo to scan, no fabricated blind spots (the contract stays lean).
    g = graph_ir.from_resolved_graph(json.loads(FIXTURE.read_text(encoding="utf-8")))
    model = codebase.decompose(g)                          # no repo
    assert model["blindspots"][0]["mechanism"] == "DI"     # only the one already in the fixture
    assert len(model["blindspots"]) == 1


def test_ambient_collaborator_keeps_cores_separate_many_to_many():
    """A collaborator shared by MORE than half the cores is ambient → it does NOT fuse them;
    it attaches to EACH seam (the legitimate many-to-many), avoiding the hairball fusion."""
    data = {
        "version": 1, "anchor": {"id": "a", "symbol": "Svc", "file": "s.ts", "range": [1, 40]},
        "language": "typescript", "resolutionQuality": "FULL", "depth": 2, "complete": True,
        "nodes": [
            {"id": "a", "symbol": "Svc", "kind": "class", "file": "s.ts", "range": [1, 40], "enclosing": "", "complexity": 40},
            {"id": "m1", "symbol": "m1", "kind": "method", "file": "s.ts", "range": [5, 10], "enclosing": "Svc", "complexity": 6},
            {"id": "m2", "symbol": "m2", "kind": "method", "file": "s.ts", "range": [12, 18], "enclosing": "Svc", "complexity": 7},
            {"id": "m3", "symbol": "m3", "kind": "method", "file": "s.ts", "range": [20, 26], "enclosing": "Svc", "complexity": 7},
            {"id": "u", "symbol": "log", "kind": "function", "file": "u.ts", "range": [1, 5], "enclosing": "", "complexity": 5},
        ],
        "edges": [
            {"from": "m1", "to": "u", "kind": "call", "provenance": "RESOLVED_FULL"},
            {"from": "m2", "to": "u", "kind": "call", "provenance": "RESOLVED_FULL"},
            {"from": "m3", "to": "u", "kind": "call", "provenance": "RESOLVED_FULL"},
        ],
        "blindspots": [], "unresolved": [],
    }
    g = graph_ir.from_resolved_graph(data)
    model = codebase.decompose(g)
    sm = _seams_of(model)
    assert len({sm["m1"], sm["m2"], sm["m3"]}) == 3        # ambient util does NOT fuse them
    assert sm["u"] == sm["m1"] | sm["m2"] | sm["m3"]       # u attaches to each (many-to-many)


def test_floor_single_core_is_one_seam():
    """F2 floor: a single-core anchor + its consumer = ONE intent-seam (no file fragmentation —
    the bug Brice caught). seam-to-seam wiring is deferred to the LLM intent-split."""
    g = graph_ir.from_resolved_graph({
        "version": 1,
        "anchor": {"id": "a", "symbol": "Widget", "file": "ui/Widget.tsx", "range": [0, 20]},
        "language": "typescriptreact", "resolutionQuality": "FULL", "depth": 2, "complete": True,
        "nodes": [
            {"id": "a", "symbol": "Widget", "kind": "function", "file": "ui/Widget.tsx", "range": [0, 20], "enclosing": "", "complexity": 20},
            {"id": "c", "symbol": "Page", "kind": "function", "file": "pages/Home.tsx", "range": [0, 40], "enclosing": "", "complexity": 40},
        ],
        "edges": [{"from": "c", "to": "a", "kind": "reference", "provenance": "RESOLVED_FULL"}],
        "blindspots": [], "unresolved": [],
    })
    model = codebase.decompose(g)
    sm = _seams_of(model)
    assert len(sm["a"]) == 1 and sm["a"] == sm["c"]        # anchor + consumer → one seam
    assert model["seamEdges"] == []                        # floor defers seam-to-seam wiring
