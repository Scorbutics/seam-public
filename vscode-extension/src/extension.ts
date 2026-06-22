import * as vscode from "vscode";
import { execFile, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { computeSymbolFacts } from "./facts";
import { VSCodeSymbolResolver, anchorSymbolAt, verifyMethodAttribution, MethodCandidate } from "./resolver";
import * as lm from "./lm";

// --- the JSON contract emitted by the TS CLI `--emit-seams` ---
interface Rewire { removed: string[]; added: string[]; }
interface ExternalRef { symbol: string; source: string; }
// Blast radius (diff mode): a file OUTSIDE the diff that imports a symbol THIS hunk defines.
// "resolved" = the import resolves to the changed file (a real consumer); "suggested" = an
// unresolvable but basename-matching import (a blind spot to verify, never asserted).
interface Consumer { file: string; symbol: string; status: string; }
// Model B: a PROPOSED behavioural partition of a core. The `ranges` are RESOLVED (real code
// regions); the grouping is a *proposal* — rendered with a deliberately distinct affordance so
// it never reads as verified structure (R-B3).
interface SubCore { id: string; label: string; ranges: [number, number][]; reads: string[]; proposed: boolean; }
// Model A: a contract member (param/prop) of a core. An invoked callback is role "link"
// (threaded behaviour); read-only data is "environment". RESOLVED — these are real uses.
interface ContractFeed { from: string; value: string; line: number; valLine?: number; valCol?: number; }  // a consumer's value for a prop (A2; valLine/valCol = its position, A3)
interface ContractMember { name: string; role: string; ranges: [number, number][]; invoked: boolean; feeds?: ContractFeed[]; }
interface SeamHunk { id: string; file: string; start: number; end: number; role: string; label?: string; confidence?: number; relevant?: boolean; external?: string[]; externalRefs?: ExternalRef[]; rewire?: Rewire | null; subcores?: SubCore[]; contract?: ContractMember[]; provenance?: string; caller?: boolean; consumers?: Consumer[]; wireTargets?: { file: string; start: number }[]; direction?: "forward" | "backward"; }
interface Seam { id: string; label: string; linkOnly: boolean; uncertain: boolean; warnings: string[]; hunks: SeamHunk[]; suggested?: boolean; tier?: "spine" | "supporting" | "off"; impact?: SeamImpact; }
// Diff-review IMPACT (the diff↔codebase bridge, --review-impact): what a change touches BEYOND its own
// lines — transitive consumers + cross-stack data-flow readers/writers in files NOT in the PR, each graded
// by the deterministic relevance floor (relevant shown / unknown to verify / irrelevant suppressed).
type Relevance = "relevant" | "unknown" | "irrelevant";
interface ExternalImpact { symbol: string; file: string; hop: number; relevance: Relevance; }
interface CrossStackEdge { symbol: string; file: string; key: string; relation: string; provenance: string; relevance: Relevance; triageReason?: string; }
interface SeamImpact { external: ExternalImpact[]; crossStack: CrossStackEdge[]; gaps: { mechanism: string; evidence: string }[]; truncated?: boolean; }
// Altitude mid-level: a deterministic STRUCTURAL grouping of a big cluster's seams (by coupling +
// directory), so the reviewer collapses/expands groups to zoom. Absent on small/tight clusters.
interface SubGroup { label: string; seamIds: string[]; }
interface Cluster { id: string; intent: string; colorIndex: number; seams: Seam[]; subgroups?: SubGroup[]; spine?: string[]; }
// Codebase-mode adds honest-gap fields (the extension reads them additively; diff-mode
// omits them, so all are optional). `resolutionQuality` drives the honesty banner, and
// `unresolved`/`blindspots` are the UNKNOWN / statically-opaque overlays (plan §1/§2).
// Codebase mode's honest-gap overlays (plan §1/§2). A SUGGESTED candidate is NEVER a
// resolved edge — it's an unverified guess for a statically-opaque mechanism.
interface SuggestedCandidate { symbol: string; provenance: string; }
interface BlindSpot { node: string; mechanism: string; evidence: string; candidates: SuggestedCandidate[]; }
interface Unresolved { node: string; query: string; reason: string; }
interface SeamEdge { from: string; to: string; provenance: string; }   // resolved seam-to-seam wiring (S1)
interface GraphEdge { from: string; to: string; kind: string; provenance: string; line?: number; }   // the raw symbol→symbol graph (chain view); line = call-site in `from`'s file
interface SeamContract { seamA: string; seamB: string; links: GraphEdge[]; blurry: boolean; }   // the symbols bridging two seams
interface Usage {
  calls: number; input_tokens: number; output_tokens: number;
  total_tokens: number; cost_usd: number; duration_ms: number; backends: string[];
}
// The contract version the engine stamps onto every --emit-seams model (see ts/src/core/contract.ts
// and docs/SEAM_JSON_CONTRACT.md). This client is built against this major; a higher major from a
// newer engine means fields may have changed meaning, so we warn rather than silently mis-render.
const SEAM_SCHEMA_VERSION = 1;
interface SeamModel {
  schemaVersion?: number;   // stamped by the engine; absent on pre-contract runs (treated as v1)
  clusters: Cluster[]; tests: SeamHunk[]; noise: SeamHunk[];
  usage?: Usage;     // tokens/cost of the LLM passes (claude backend only; absent for det/host runs)
  mode?: string; anchor?: string; resolutionQuality?: string; language?: string;
  complete?: boolean; unresolved?: Unresolved[]; blindspots?: BlindSpot[]; seamEdges?: SeamEdge[];
  edges?: GraphEdge[];     // the directed call/dependency graph — for the chain view
  seamContracts?: SeamContract[];   // the symbols bridging each pair of seams (the inter-seam contract)
  selectedSeam?: string;   // P1: the seam matching the user's intent (auto-focused), or ""
  autoGrown?: boolean;     // P5: an LLM-grown footprint — show it ALL (the growth is the answer), don't isolate
  // Bidirectional footprint: `shape` = policy (cross-cutting, no spine → mechanism + N enforcement sites)
  // vs flow (a pipeline with a spine); `lead` = which slice the question wants front (backward/forward/both).
  shape?: "policy" | "flow"; lead?: "backward" | "forward" | "both";
  // The .seam learned-adapter flywheel: framework-key coupling adapters this run consulted (replayed
  // offline) + newly learned (LLM-once → deterministic-forever). Surfaced as a reviewable/promotable record.
  adapters?: { used?: { name: string; scope: "repo" | "shared" }[]; learned?: string[] };
}
// One occurrence of a hunk in a seam (a link can appear in several) — carries the
// labels so decorations (role) and CodeLens (intent · seam) share one index.
interface IndexEntry { hunk: SeamHunk; seamId: string; seamLabel: string; intent: string; }

// ROLE is the primary read (you review BY role), so it drives the editor colour —
// gutter bar + scrollbar mark. Semantic, theme-safe hues; cluster grouping lives in
// the tree. The gutter (never the line background) coexists with the diff's green/red.
const ROLE_COLORS: Record<string, string> = {
  core: "#e8a33d",        // amber — the new logic / decisions (the meat)
  link: "#4a90d9",        // blue  — wiring / connections
  environment: "#8a8a8a", // gray  — ambient support (decls, imports, data)
  test: "#5abf7a",        // green — verification
  noise: "#c0c0c0",       // faint — skip
};
const ROLES = ["core", "link", "environment", "test", "noise"];
// Roles top out around ~0.8 accuracy (the core/link frontier is genuinely blurry),
// so we don't pretend they're certain: a hunk whose self-consistency role vote was
// SPLIT (< this share agreeing) is surfaced as a "maybe", not a fact. Mirrors
// UNCERTAIN_THRESHOLD in seams.py. The tool structures; the human judges.
const UNCERTAIN_THRESHOLD = 0.6;
const isUncertain = (h: SeamHunk): boolean =>
  h.confidence !== undefined && h.confidence < UNCERTAIN_THRESHOLD;
const confPct = (h: SeamHunk): number => Math.round((h.confidence ?? 1) * 100);
// An unwired hunk may couple to code OUTSIDE the diff (a symbol imported from a
// module defined nowhere in the change) — surfaced as "→ @coss/ui" so the §I
// boundary reads as "go look there", not as a blank/missing wiring.
const extTag = (h: SeamHunk): string =>
  h.external && h.external.length ? ` → ${h.external.slice(0, 2).join(", ")}` : "";
// A crisp A->B rewire read from the hunk's own -/+ lines (showToast -> toastManager)
// — the §I "re-routes A->B" signal. "" when the hunk isn't a focused swap.
const rewireStr = (h: SeamHunk): string =>
  h.rewire && h.rewire.removed.length && h.rewire.added.length
    ? `${h.rewire.removed.join("/")} → ${h.rewire.added.join("/")}` : "";
// Occurrence identity. A hunk can appear in several seams; once span-level wiring
// lands, the SAME hunk id appears with DIFFERENT sub-ranges (one per core it wires),
// so focus/nav/decorations must key on (id + range), not the id alone. Today every
// occurrence carries the full range, so this behaves exactly like the id did.
const spanKey = (h: SeamHunk): string => `${h.id}:${h.start}:${h.end}`;

// A node's display name: its file basename, EXCEPT a module ENTRY (`index.*`) is identified by its
// DIRECTORY — `…/process-payment/index.ts` → `process-payment/` — because the basename `index.ts` is
// noise (it's how a string-dispatch crossing to an edge function / route lands). See the edge ladder.
const isModuleEntry = (h: SeamHunk): boolean => /^index\.\w+$/.test(h.file.split("/").pop() ?? "");
const hunkName = (h: SeamHunk): string => {
  const parts = h.file.split("/");
  return isModuleEntry(h) && parts.length > 1 ? `${parts[parts.length - 2]}/` : (parts.pop() ?? h.file);
};
// Wire-target pill (intra-seam closeness): in a MULTI-core seam, a link shows which core(s) it
// wires — resolved by shared distinctive symbols. Targets are grouped by file so same-file cores
// collapse to "role.service.ts:43, :79". Absent for single-core seams or symbol-less links.
const wireTargetTag = (h: SeamHunk): string => {
  const wt = h.wireTargets ?? [];
  if (!wt.length) return "";
  const byFile = new Map<string, number[]>();
  for (const t of wt) {
    const base = t.file.split("/").pop() ?? t.file;
    (byFile.get(base) ?? byFile.set(base, []).get(base)!).push(t.start);
  }
  const parts = [...byFile].map(([base, lines]) => {
    const ls = [...new Set(lines)].sort((a, z) => a - z);
    return `${base}:${ls[0]}${ls.slice(1).map((l) => `, :${l}`).join("")}`;
  });
  return `→ ${parts.join("  ")}`;
};
// A non-FULL edge into this node — a string-dispatch heuristic (RESOLVED_PARTIAL) or an LLM/assumed
// crossing (SUGGESTED): surface it so the node reads as a boundary to verify, not a hard import.
const provTag = (h: SeamHunk): string =>
  /SUGGEST/i.test(h.provenance ?? "") ? "~ suggested" : /PARTIAL/.test(h.provenance ?? "") ? "↝ dispatch (partial)" : "";
// Seam identity is carried by the OUTLINE (border) + the gutter bar; the wash is a
// faint tint only — kept deliberately low so code stays legible and, crucially, so a
// single layer is barely-there. Opacity must NEVER stack: every line is painted by at
// most one fill decoration (see fillFor), so an overlap reads as one blended tint, not
// two washes compositing into mud.
// The role SPINE is the primary read: a calm, continuous bar in the gutter whose WIDTH
// encodes review priority — core is loudest (the decisions you must understand), links are
// quiet plumbing, noise is a hairline that recedes. Colour carries the role; weight carries
// "how much should this draw the eye". Replaces the old per-hunk perimeter box (intrusive).
const ROLE_WEIGHT: Record<string, number> = {
  core: 4, link: 2.4, environment: 2.4, test: 2.4, noise: 1.2,
};
// The wash never carries the signal (the spine does) — it's a barely-there tint, painted
// ONLY on the focused seam so a block reads as cohesive without flooding the editor. Single
// layer, pre-blended, never stacked.
const ROLE_BG_ALPHA = 0.05;
// In focus, the OTHER seams' changed lines fade back (not hidden — still context) so the one
// seam you're reading pops. A whisper of grey keeps them locatable.
const DIM_OPACITY = "0.4";
// Pre-blend several role colours into ONE rgba (average RGB, single alpha) so an overlap
// line (e.g. core+link) gets a single blended fill — never two stacked washes. Mirrors the
// split gutter bar's signal without the compositing that darkened overlaps.
function blendRgba(hexes: string[], a: number): string {
  let r = 0, g = 0, b = 0;
  for (const hex of hexes) {
    const n = parseInt(hex.slice(1), 16);
    r += (n >> 16) & 255; g += (n >> 8) & 255; b += n & 255;
  }
  const k = Math.max(1, hexes.length);
  return `rgba(${Math.round(r / k)},${Math.round(g / k)},${Math.round(b / k)},${a})`;
}

type TDeco = vscode.TextEditorDecorationType;
let model: SeamModel | undefined;
let repoRoot = "";
// P2 (expand): the accumulating ResolvedGraph for this session (a fresh analysis resets it; expanding
// a node merges its scan in). `sessionIntent` is re-applied on each expand so the focus persists.
const SESSION_GRAPH = ".seam-session-graph.json";
let sessionGraph: string | null = null;
let sessionIntent = "";
// Progressive reveal (two-step): true while the deterministic skeleton is painted and the LLM
// enrichment pass (naming + tiering) is still running over the same graph — drives the in-tree loader.
let enriching = false;
// Diff review: true while the base seams are painted and the impact pass (codebase blast radius +
// cross-stack data-flow) is still being annotated over the same classification — drives the loader.
let annotatingImpact = false;
let fileIndex: Map<string, IndexEntry[]> = new Map();   // repo-relative file → its hunk occurrences
// Seam graph (S1): seam id → label, and seam id → its wired neighbours (resolved seam-to-seam).
let seamLabel: Map<string, string> = new Map();
let seamNeighbors: Map<string, { id: string; provenance: string }[]> = new Map();
// The inter-seam CONTRACT, inlined: seam id → the contracts it participates in, keyed by the OTHER
// seam (the partner). Lets a seam render its bridging symbols under its own connection rows instead
// of in a detached bottom section. A contract is symmetric, so it indexes under both of its seams.
let seamContractsByPartner: Map<string, Map<string, SeamContract>> = new Map();
// Combo-keyed like decoSpine: one cached fill per role-combo ("core", "core|link", …), so any
// given line is covered by exactly ONE background decoration → opacity is flat everywhere and
// overlaps blend instead of stacking. Built lazily by fillFor; painted only on the focused seam.
let decoFill: Map<string, TDeco> = new Map();
// The role SPINE: a continuous, weight-coded bar in the gutter — the PRIMARY role signal
// (the per-hunk perimeter box was retired; it boxed the editor in). A line's meaning is
// SEAM-DEPENDENT: the same lines can be `core` in their home seam AND `link` in a sibling
// seam, so a line carrying >1 role gets a SPLIT spine (adjacent thin stripes) rather than an
// arbitrary single colour winning. Keyed by the sorted role-combo ("core" or "core|link"),
// built lazily; re-paint clears the stale combos first.
let decoSpine: Map<string, TDeco> = new Map();
// FOCUS dimming: the other seams' changed lines fade to DIM_OPACITY so the focused seam
// reads. One shared type, re-targeted each paint.
let decoDim: TDeco;
// Model B: the PROPOSED sub-core overlay — deliberately DISTINCT from the solid role fills
// (a dashed violet outline), so a proposed grouping reads as a proposal, never as verified
// structure (R-B3). Painted only for the sub-core the user selects (opt-in), never in show-all.
let decoProposed: TDeco;
let activeProposed: { filePath: string; ranges: vscode.Range[] } | null = null;
let lensProvider: SeamLensProvider;
let gutterDir = "";
let treeProvider: SeamTreeProvider;
let treeView: vscode.TreeView<Node>;
let adapterProvider: AdapterTreeProvider;
let adapterView: vscode.TreeView<AdapterNode>;
let extContext: vscode.ExtensionContext;
// FOCUS: when a seam (or cluster) is selected in the tree, only ITS hunks are
// decorated — every other seam disappears from the editor, so you review one
// intent in isolation. null = show all. "Show all seams" (eye) resets it.
let focusIds: Set<string> | null = null;
let focusLabel = "";
// P2 #2 (isolate): in codebase mode, focusing a seam also HIDES the other seams from the TREE (not
// just the editor decorations) — "select a seam → the others are discarded". null = show all seams.
let focusedSeamId: string | null = null;
// Chain view: render symbol→symbol EDGES (the call/dependency graph) under each node, with their
// nature (RESOLVED / RESOLVED_PARTIAL / SUGGESTED), instead of the role drill-downs. A second reading
// of the same footprint — "how the symbols wire together" rather than "what role each plays".
let chainView = false;
let lastRunBanner = "";
let navCursor = -1;   // position within the current scope's ordered hunk list

// Persisted per-workspace so the last run survives a window reload — no need to
// re-spend the LLM pass on the same diff.
const STATE_KEY = "seam.lastRun";
interface SavedRun { model: SeamModel; repoRoot: string; range: string; ts: number; }

export function activate(context: vscode.ExtensionContext) {
  try {
    activateInner(context);
  } catch (e) {
    // Surface activation failures instead of dying silently (= "nothing shows").
    vscode.window.showErrorMessage(`Seam activation error: ${e instanceof Error ? e.message : e}`);
  }
}

function activateInner(context: vscode.ExtensionContext) {
  extContext = context;
  gutterDir = path.join(context.globalStorageUri.fsPath, "gutter");
  fs.mkdirSync(gutterDir, { recursive: true });

  // Other seams' changed lines fade behind the focused one (text + spine), never disappear.
  decoDim = vscode.window.createTextEditorDecorationType({ opacity: DIM_OPACITY });

  decoProposed = vscode.window.createTextEditorDecorationType({
    border: "1px dashed rgba(163,113,247,0.9)",       // violet, dashed — "a proposal", not a fact
    // Border-only on purpose: a background here would be a SECOND fill layer over the role
    // wash and reintroduce the opacity stacking. The dashed outline alone reads as a proposal.
    isWholeLine: true,
    overviewRulerColor: "rgba(163,113,247,0.85)",
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  treeProvider = new SeamTreeProvider();
  treeView = vscode.window.createTreeView("seam.tree", { treeDataProvider: treeProvider });
  adapterProvider = new AdapterTreeProvider();
  adapterView = vscode.window.createTreeView("seam.adapters", { treeDataProvider: adapterProvider });
  lensProvider = new SeamLensProvider();
  context.subscriptions.push(
    treeView,
    adapterView,
    vscode.commands.registerCommand("seam.adapters.refresh", () => adapterProvider.refresh()),
    vscode.commands.registerCommand("seam.adapters.manage", async () => { await adapterProvider.refresh(); try { await vscode.commands.executeCommand("seam.adapters.focus"); } catch { /* view focus best-effort */ } }),
    vscode.commands.registerCommand("seam.adapters.promote", promoteAdapter),
    vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "git" }], lensProvider),
    vscode.commands.registerCommand("seam.detangle", detangle),
    vscode.commands.registerCommand("seam.mapIntent", mapIntent),
    vscode.commands.registerCommand("seam.review", () => runReview("HEAD")),
    vscode.commands.registerCommand("seam.reviewWithSubmodules", () => runReview("HEAD", true)),
    vscode.commands.registerCommand("seam.reviewCommit", reviewCommit),
    vscode.commands.registerCommand("seam.loadSeams", loadSeams),
    vscode.commands.registerCommand("seam.analyzeCodebase", analyzeCodebase),
    vscode.commands.registerCommand("seam.analyzeModule", analyzeModule),
    vscode.commands.registerCommand("seam.analyzeFromIntent", () => analyzeFromIntent(false)),
    vscode.commands.registerCommand("seam.autoMapIntent", autoMapIntent),
    vscode.commands.registerCommand("seam.expandNode", expandNode),
    vscode.commands.registerCommand("seam.expandDown", expandDown),
    vscode.commands.registerCommand("seam.crossBoundary", crossBoundary),
    vscode.commands.registerCommand("seam.clear", clearAll),
    vscode.commands.registerCommand("seam.showAll", showAll),
    vscode.commands.registerCommand("seam.toggleChain", () => {
      chainView = !chainView;
      vscode.commands.executeCommand("setContext", "seam.chainView", chainView);
      updateBanner();
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand("seam.next", (fromId?: string) => navStep(1, fromId)),
    vscode.commands.registerCommand("seam.prev", (fromId?: string) => navStep(-1, fromId)),
    vscode.commands.registerCommand("seam.open", openHunk),
    vscode.commands.registerCommand("seam.goToDef", goToDef),
    vscode.commands.registerCommand("seam.openSubcore", openSubcore),
    vscode.commands.registerCommand("seam.openContract", openContract),
    vscode.commands.registerCommand("seam.openFeed", openFeed),
    vscode.commands.registerCommand("seam.openLocation", openLocation),
    vscode.commands.registerCommand("seam.focusSeamById", focusSeamById),
    treeView.onDidChangeSelection(onSelect),
    vscode.window.onDidChangeVisibleTextEditors(applyToVisible),
  );
  restoreLast();
  ensureDiffCodeLens();
}

// Seam labels are CodeLens, but VS Code HIDES CodeLens in the diff editor unless
// `diffEditor.codeLens` is on (off by default) — so the labels don't exist there
// without it. It's required for a core feature, so enable it once (and say so; the
// user can revert in Settings). Gated by a flag so we don't fight a later opt-out.
async function ensureDiffCodeLens() {
  if (extContext.globalState.get("seam.enabledDiffCodeLens")) return;
  extContext.globalState.update("seam.enabledDiffCodeLens", true);
  const cfg = vscode.workspace.getConfiguration("diffEditor");
  if (cfg.get<boolean>("codeLens") !== true) {
    await cfg.update("codeLens", true, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      "Seam turned on diffEditor.codeLens so the intent · seam labels show above hunks in diffs " +
      "(revert in Settings if you don't want it).");
  }
}

// Re-paint everything that depends on the model/focus state.
function rerender() {
  navCursor = -1;   // scope changed → next Next starts at the first hunk
  applyToVisible(vscode.window.visibleTextEditors);
  lensProvider?.refresh();
  updateBanner();
  // The "Show all" eye is only inline while something is focused/isolated (gated by
  // `seam.focused` in package.json) — so the toolbar shows it exactly when it's useful.
  vscode.commands.executeCommand("setContext", "seam.focused", !!focusIds || !!focusedSeamId);
}

function focusSeamById(seamId: string) {
  if (!model || !seamId) return;
  for (const cl of model.clusters)
    for (const s of cl.seams)
      if (s.id === seamId) {
        focusIds = new Set(s.hunks.map(spanKey));
        focusLabel = s.label;
        rerender();
        return;
      }
}

// Selecting a node FOCUSES it (seam or hunk → that seam; cluster → all its seams).
function onSelect(e: vscode.TreeViewSelectionChangeEvent<Node>) {
  const sel = e.selection[0];
  // resolved targets, the blind-spot overlay, and proposed sub-cores don't drive seam focus
  // (a sub-core paints its own overlay via its command instead).
  if (sel && (sel.kind === "extTarget" || sel.kind === "shadows" || sel.kind === "blindspot"
              || sel.kind === "candidate" || sel.kind === "unknown" || sel.kind === "subcore"
              || sel.kind === "contract" || sel.kind === "feed" || sel.kind === "feedDef"
              || sel.kind === "seamLink")) return;
  // An auto-grown footprint is shown whole (the growth is the answer) — clicking a node must NOT
  // isolate a seam (that's the manual flow's "select → discard others"). It still focuses decorations.
  const codebase = model?.mode === "codebase";
  const canIsolate = codebase && !model?.autoGrown;
  if (!sel) { focusIds = null; focusLabel = ""; }
  else if (sel.kind === "seam" || sel.kind === "hunk") {
    focusIds = new Set(sel.seam.hunks.map(spanKey));
    focusLabel = sel.seam.label;
    if (canIsolate) { focusedSeamId = sel.seam.id; treeProvider.refresh(); }   // isolate this seam in the tree
  } else if (sel.kind === "subgroup") {
    // selecting a sub-group focuses ALL its seams' hunks (the altitude's mid-level highlight).
    const ids = new Set(sel.group.seamIds);
    focusIds = new Set(sel.cluster.seams.filter((s) => ids.has(s.id)).flatMap((s) => s.hunks.map(spanKey)));
    focusLabel = sel.group.label;
  } else if (sel.kind === "cluster") {
    focusIds = new Set(sel.cluster.seams.flatMap((s) => s.hunks.map(spanKey)));
    focusLabel = sel.cluster.intent;
    if (codebase && focusedSeamId) { focusedSeamId = null; treeProvider.refresh(); }   // cluster = widen
  }
  rerender();
}

function showAll() {
  focusIds = null;
  focusLabel = "";
  focusedSeamId = null;      // widen the tree back to every seam
  clearProposed();           // show-all is the verified view; drop the opt-in proposed overlay
  treeProvider.refresh();
  rerender();
}

// The hunks currently in scope (focused seam, else all), deduped, in (file, line)
// order — the list Next/Previous step through.
function navList(): SeamHunk[] {
  if (!model) return [];
  const out: SeamHunk[] = [];
  const seen = new Set<string>();
  const take = (h: SeamHunk) => {
    const k = spanKey(h);
    if (focusIds && !focusIds.has(k)) return;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(h);
  };
  for (const cl of model.clusters) for (const s of cl.seams) for (const h of s.hunks) take(h);
  if (!focusIds) { model.tests.forEach(take); model.noise.forEach(take); }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start));
  return out;
}

function navStep(delta: number, fromKey?: string) {
  const list = navList();
  if (!list.length) { vscode.window.showInformationMessage("Seam: no hunks in scope."); return; }
  if (fromKey) {                                  // inline ↑/↓ navigate relative to THIS span
    const i = list.findIndex((h) => spanKey(h) === fromKey);
    if (i >= 0) navCursor = i;
  }
  navCursor = (((navCursor + delta) % list.length) + list.length) % list.length;
  void openHunk(list[navCursor]);
}

function updateBanner() {
  if (!treeView) return;
  const total = model?.clusters.reduce((a, c) => a + c.seams.length, 0) ?? 0;
  const chain = chainView ? "⛓ chain view — each symbol shows its links (→ depends · ← used by · ⧉ suggested).  " : "";
  treeView.message = chain + (focusedSeamId
    ? `intent: ${focusLabel}  —  isolated 1 of ${total} seams · press the eye (Show all) to widen`
    : focusIds
      ? `focus: ${focusLabel}  —  press the eye (Show all seams) to see everything`
      : lastRunBanner);
}

// Load a model into the view (tree + decorations + the "last run" message banner).
function activateModel(m: SeamModel, root: string, range: string, ts: number) {
  const v = m.schemaVersion ?? SEAM_SCHEMA_VERSION;   // pre-contract runs are v1
  if (v > SEAM_SCHEMA_VERSION)
    vscode.window.showWarningMessage(
      `Seam: this engine emits contract v${v}, but the extension understands v${SEAM_SCHEMA_VERSION}. `
      + `Some seams may render incorrectly — update the Seam extension.`);
  model = m;
  repoRoot = root;
  resolveCache.clear();       // a new run invalidates resolved external targets
  focusIds = null;            // a fresh/restored run starts showing all seams
  focusLabel = "";
  focusedSeamId = null;
  // P1 (intent focus) + P2 #2 (isolate): if the run carried a question, the engine marked the matching
  // seam — lead with it AND hide the other seams from the tree (the user presses "Show all seams" to
  // widen). EXCEPT for an AUTO-grown footprint (P5): the LLM grew the whole answer path (service →
  // repository → …), so show it ALL — isolating one seam would hide the layers it just reached.
  if (m.selectedSeam && !m.autoGrown) {
    const sel = m.clusters.flatMap((c) => c.seams).find((s) => s.id === m.selectedSeam);
    if (sel) { focusIds = new Set(sel.hunks.map(spanKey)); focusLabel = sel.label; focusedSeamId = sel.id; }
  }
  // Focus-first default: a multi-seam DIFF run leads INSIDE the first seam (editor shows one
  // intent cleanly; the others dim) rather than the flat all-seams landscape. The tree still
  // lists every seam — focusedSeamId stays null so it isn't narrowed — and the eye widens the
  // editor to show-all. Codebase/intent/auto-grown runs keep their own framing above.
  if (!focusIds && m.mode !== "codebase" && !m.autoGrown) {
    const total = m.clusters.reduce((a, c) => a + c.seams.length, 0);
    const lead = sortedSeams(m.clusters[0]?.seams ?? [])[0];   // == the top of the panel (risk-first)
    if (total > 1 && lead) { focusIds = new Set(lead.hunks.map(spanKey)); focusLabel = lead.label; }
  }
  // Codebase mode leads with the HONESTY FRONTIER (plan §4): the probed resolution quality
  // and the size of the blind-spot map sit in the persistent banner, not just a toast.
  if (m.mode === "codebase") {
    const nu = m.unresolved?.length ?? 0, nb = m.blindspots?.length ?? 0;
    const gaps = (nu || nb) ? ` · ${nu} unknown, ${nb} blind spot(s)` : " · no blind spots in view";
    const incomplete = m.complete === false ? " · depth-truncated" : "";
    lastRunBanner = `${range} · resolution ${m.resolutionQuality ?? "?"}${gaps}${incomplete}`;
  } else {
    lastRunBanner = `last run: ${range} · ${new Date(ts).toLocaleString()}`;
  }
  buildIndex();
  treeProvider.refresh();
  vscode.commands.executeCommand("setContext", "seam.active", true);  // enable nav keys
  rerender();
  notifyLearnedAdapters(m);   // the flywheel turned this run → surface it + refresh the adapters view
}

// When a run LEARNED new `.seam/` adapters (the LLM deduced a coupling for an unknown framework), notify
// the user and refresh the adapter view so the new entries (and the promote action) are right there.
function notifyLearnedAdapters(m: SeamModel): void {
  const learned = m.adapters?.learned ?? [];
  if (!learned.length) return;
  adapterProvider?.refresh();
  const names = learned.slice(0, 3).join(", ") + (learned.length > 3 ? `, +${learned.length - 3} more` : "");
  vscode.window.showInformationMessage(
    `Seam learned ${learned.length} data-coupling adapter${learned.length !== 1 ? "s" : ""} for an unknown framework: ${names}. They replay offline now — promote to share across repos.`,
    "Manage adapters",
  ).then((pick) => { if (pick === "Manage adapters") vscode.commands.executeCommand("seam.adapters.manage"); });
}

// Render a pre-built `--emit-seams` JSON directly (no engine run, no LLM) — for demos,
// recordings, and offline review of a stored decomposition. The seam file's hunk paths must
// be RELATIVE to the open folder, so open the matching repo first. Reads `seam.demoSeamsFile`
// if set, otherwise prompts. Activates and persists it like a normal run (restoreLast picks it up).
async function loadSeams() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showErrorMessage("Seam: open the repo the seams file refers to first."); return; }
  let file = vscode.workspace.getConfiguration("seam").get<string>("demoSeamsFile") || "";
  if (!file) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: "Load seams",
      filters: { "Seam model": ["json"] },
    });
    if (!picked?.length) return;
    file = picked[0].fsPath;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as SeamModel;
    if (!parsed.clusters) throw new Error("not a seams model (no `clusters`)");
    repoRoot = folder.uri.fsPath;
    const ts = Date.now();
    activateModel(parsed, repoRoot, path.basename(file), ts);
    extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range: path.basename(file), ts } as SavedRun);
    const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
    vscode.window.showInformationMessage(
      `Seam: loaded ${parsed.clusters.length} clusters, ${n} seams from ${path.basename(file)}.  ` +
      `core=amber · link=blue · environment=gray · test=green · noise=faint`);
  } catch (e) {
    vscode.window.showErrorMessage(`Seam: could not load seams — ${e instanceof Error ? e.message : e}`);
  }
}

function restoreLast() {
  const saved = extContext.workspaceState.get<SavedRun>(STATE_KEY);
  const folder = vscode.workspace.workspaceFolders?.[0];
  // Only restore if it belongs to the folder currently open.
  if (saved && folder && saved.repoRoot === folder.uri.fsPath) {
    activateModel(saved.model, saved.repoRoot, saved.range, saved.ts);
  }
}

// Every combo-keyed decoration (spine + fill) painted in any editor — the set a re-paint
// or clear must wipe so stale combos vanish.
function comboDecos(): TDeco[] {
  return [...decoSpine.values(), ...decoFill.values()];
}

export function deactivate() {
  // Dispose decoration types only — do NOT wipe the persisted run (that's the cache).
  comboDecos().forEach((d) => d.dispose());
  decoSpine.clear();
  decoFill.clear();
  decoDim?.dispose();
  decoProposed?.dispose();
}

// FILL for a set of roles: a faint, PRE-BLENDED background + scrollbar mark, one cached
// decoration per role-combo (exactly like spineFor). A line is painted by a single fillFor
// decoration, so opacity is flat everywhere — an overlap (core+link) shows as one blended
// tint, never two washes compositing. The SPINE (spineFor) carries the role; the fill just
// hints at the block's extent, and only on the focused seam.
function fillFor(roles: string[]): TDeco {
  const ordered = ROLES.filter((r) => roles.includes(r));
  const key = ordered.join("|") || "noise";
  const hit = decoFill.get(key);
  if (hit) return hit;
  const cols = (ordered.length ? ordered : ["noise"]).map((r) => ROLE_COLORS[r] ?? "#c0c0c0");
  const deco = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: cols[0],
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    backgroundColor: blendRgba(cols, ROLE_BG_ALPHA),
    isWholeLine: true,
  });
  decoFill.set(key, deco);
  return deco;
}

// SPINE for a set of roles: a continuous, weight-coded bar drawn full-height in the gutter so
// consecutive lines tile into one unbroken rail. One role → a single bar whose WIDTH is the
// role's review weight (core widest, noise a hairline). Several (an OVERLAP) → thin adjacent
// stripes, left→right in ROLES order, so a line that is core in its home seam and link in a
// sibling reads "core that also links" straight off the gutter. Cached by combo key.
function spineFor(roles: string[]): TDeco {
  const ordered = ROLES.filter((r) => roles.includes(r));
  const key = ordered.join("|") || "noise";
  const hit = decoSpine.get(key);
  if (hit) return hit;
  const list = ordered.length ? ordered : ["noise"];
  const H = 18;            // = line height; full-height rects tile into a gapless rail
  let x = 1;
  const rects = list.map((r) => {
    const w = list.length === 1 ? (ROLE_WEIGHT[r] ?? 2) : Math.max(1.4, 4.8 / list.length);
    const op = r === "noise" ? 0.45 : 0.95;       // noise recedes
    const rect = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${H}" fill="${ROLE_COLORS[r] ?? "#c0c0c0"}" opacity="${op}"/>`;
    x += w + (list.length > 1 ? 0.5 : 0);         // hairline gap only when stripes share the rail
    return rect;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="${H}">${rects}</svg>`;
  const file = path.join(gutterDir, `spine-${key.replace(/\|/g, "_")}.svg`);
  fs.writeFileSync(file, svg, "utf-8");
  const deco = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(file),
    gutterIconSize: "contain",
    isWholeLine: true,
  });
  decoSpine.set(key, deco);
  return deco;
}

// --- run the engine and load the seam model ---
function toolPath(): string {
  const cfg = vscode.workspace.getConfiguration("seam").get<string>("toolPath");
  return cfg && cfg.trim() ? cfg.trim() : path.resolve(__dirname, "..", "..");
}
// Engine launcher. Two modes:
//  • bundled (default): the engine is shipped inside the extension as esbuild CJS bundles under
//    out/engine/. We run them with VS Code's OWN Node (process.execPath + ELECTRON_RUN_AS_NODE=1) —
//    so a published .vsix needs neither a `bun` runtime nor the source checkout.
//  • dev: when `seam.toolPath` points at a code-review-sort checkout, run the TS source under `bun`
//    (the F5 / iterate-on-the-engine workflow). bun resolves .ts directly.
// The grammar pack (codebase mode) ships next to the bundle and is located via SEAM_WASM_DIR.
function bunPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidate = path.join(home, ".bun", "bin", "bun");
  return fs.existsSync(candidate) ? candidate : "bun"; // fall back to PATH lookup by spawn
}
interface Engine { run: string; entryDir: string; wasmDir: string; ext: ".ts" | ".cjs"; dev: boolean; }
function engine(): Engine {
  const cfg = vscode.workspace.getConfiguration("seam").get<string>("toolPath");
  if (cfg && cfg.trim()) {
    const tool = cfg.trim();
    return { run: bunPath(), entryDir: path.join(tool, "ts", "src", "cli"),
             wasmDir: path.join(tool, "ts", "node_modules", "tree-sitter-wasms", "out"),
             ext: ".ts", dev: true };
  }
  const eng = path.join(__dirname, "engine");
  return { run: process.execPath, entryDir: eng, wasmDir: path.join(eng, "wasm"), ext: ".cjs", dev: false };
}
function engineEntry(name: "decompose" | "anchor_rank" | "adapters"): string {
  const e = engine();
  return path.join(e.entryDir, `${name}${e.ext}`);
}
// Spawn env for every engine call: point tree-sitter at the shipped grammar pack and, in bundled
// mode, make VS Code's Electron binary behave as plain Node.
function engineEnv(): NodeJS.ProcessEnv {
  const e = engine();
  const env: NodeJS.ProcessEnv = { ...process.env, SEAM_WASM_DIR: e.wasmDir };
  if (!e.dev) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}
// Friendly guard: the bundled engine missing means a broken build; in dev mode it means a bad toolPath.
function engineMissing(): string | null {
  const entry = engineEntry("decompose");
  if (fs.existsSync(entry)) return null;
  return engine().dev
    ? `Seam: engine not found at "${entry}". Check "seam.toolPath" (must be your code-review-sort checkout).`
    : `Seam: bundled engine missing at "${entry}". The extension build is incomplete — reinstall the .vsix.`;
}
// anchor_rank invocation. `args` are the CLI flags.
function anchorRankInvocation(_tool: string, args: string[]): [string, string[]] {
  return [engine().run, [engineEntry("anchor_rank"), ...args]];
}
// decompose invocation (diff + codebase mode). `args` are the CLI flags (everything after the entry).
function decomposeInvocation(_tool: string, args: string[]): [string, string[]] {
  return [engine().run, [engineEntry("decompose"), ...args]];
}

// --- learned-adapter manager (Seam Adapters view) -----------------------------------------------
// The data-coupling adapter inventory: BUILT-IN (deterministic, from the registry), LEARNT (repo-local
// `.seam/`, LLM-deduced), PROMOTED (shared store, reusable across repos). Sourced from the engine's
// `adapters list --json` so the extension never hardcodes the catalogue. The view lets you promote a
// learnt adapter into the shared store (learnt → promoted) — the human half of the flywheel.
interface AdapterEntry { name: string; type?: "key" | "carrier"; kind?: string; description: string; detail?: string; }
interface AdapterInventory { builtin: AdapterEntry[]; learnt: AdapterEntry[]; promoted: AdapterEntry[]; locations?: { repo: string; shared: string }; }
type AdapterStatus = "builtin" | "learnt" | "promoted";
type AdapterNode =
  | { kind: "group"; status: AdapterStatus; entries: AdapterEntry[] }
  | { kind: "adapter"; status: AdapterStatus; entry: AdapterEntry };

// The repo the adapter store lives under — the open workspace folder (adapters are a repo-level concern,
// independent of whether an analysis has run).
function adapterRepo(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? (repoRoot || null);
}
// Run the engine and CAPTURE stdout (the adapters CLI prints JSON / a status line there).
function runCapture(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env: engineEnv(), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message)); else resolve(stdout);
    });
  });
}
async function loadAdapterInventory(): Promise<AdapterInventory | null> {
  const repo = adapterRepo();
  if (!repo || engineMissing()) return null;
  try {
    const out = await runCapture(engine().run, [engineEntry("adapters"), "list", "--json", "--repo", repo], repo);
    return JSON.parse(out) as AdapterInventory;
  } catch { return null; }
}

class AdapterTreeProvider implements vscode.TreeDataProvider<AdapterNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private inv: AdapterInventory | null = null;
  private loaded = false;
  async refresh(): Promise<void> { this.inv = await loadAdapterInventory(); this.loaded = true; this._onDidChange.fire(); }

  async getChildren(el?: AdapterNode): Promise<AdapterNode[]> {
    if (!this.loaded) await this.refresh();
    if (!this.inv) return [];
    if (!el) {
      const groups: AdapterNode[] = [];
      const add = (status: AdapterStatus, entries: AdapterEntry[]) => { if (entries.length) groups.push({ kind: "group", status, entries }); };
      add("learnt", this.inv.learnt);       // lead with the actionable ones (promote candidates)
      add("promoted", this.inv.promoted);
      add("builtin", this.inv.builtin);
      return groups;
    }
    if (el.kind === "group") return el.entries.map((entry) => ({ kind: "adapter", status: el.status, entry }));
    return [];
  }

  getTreeItem(el: AdapterNode): vscode.TreeItem {
    const META: Record<AdapterStatus, { label: string; icon: string; color?: string; tip: string }> = {
      learnt:   { label: "Learnt (this repo)", icon: "sparkle", color: "charts.green", tip: "LLM-deduced for an unknown/homemade framework, stored in this repo's .seam/. Promote to share across repos." },
      promoted: { label: "Promoted (shared)", icon: "cloud-upload", tip: "Learned adapters you promoted into the shared store (~/.config/seam/adapters) — reused by every repo, replayed offline." },
      builtin:  { label: "Built-in", icon: "plug", tip: "Deterministic, code-level adapters shipped with Seam (DB tables, HTTP routes, file channels). Always on, offline." },
    };
    if (el.kind === "group") {
      const m = META[el.status];
      const it = new vscode.TreeItem(`${m.label}`, el.status === "builtin" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      it.description = `${el.entries.length}`;
      it.iconPath = new vscode.ThemeIcon(m.icon, m.color ? new vscode.ThemeColor(m.color) : undefined);
      it.tooltip = m.tip;
      return it;
    }
    const e = el.entry;
    const it = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.None);
    it.description = [el.status === "builtin" ? (e.kind ?? "") : (e.type ?? ""), e.detail ?? ""].filter(Boolean).join(" · ");
    it.iconPath = new vscode.ThemeIcon(
      el.status === "learnt" ? "sparkle" : el.status === "promoted" ? "cloud-upload" : "plug",
      el.status === "learnt" ? new vscode.ThemeColor("charts.green") : undefined);
    const md = new vscode.MarkdownString(`**${e.name}**  ·  _${el.status}_\n\n${e.description || "_(no description)_"}`);
    if (el.status === "learnt") md.appendMarkdown("\n\n— right-click → **Promote** to share it across repos.");
    it.tooltip = md;
    // contextValue drives the inline "promote" action — only learnt adapters can be promoted.
    it.contextValue = el.status === "learnt" ? "seam.adapter.learnt" : "seam.adapter";
    return it;
  }
}

// Promote a learnt adapter into the shared store (learnt → promoted) via the engine, then refresh.
async function promoteAdapter(node?: AdapterNode): Promise<void> {
  const repo = adapterRepo();
  if (!repo) { vscode.window.showErrorMessage("Seam: open a folder first."); return; }
  const name = node?.kind === "adapter" ? node.entry.name : undefined;
  if (!name) { vscode.window.showErrorMessage("Seam: select a learnt adapter to promote."); return; }
  try {
    await runCapture(engine().run, [engineEntry("adapters"), "promote", name, "--repo", repo], repo);
    await adapterProvider.refresh();
    vscode.window.showInformationMessage(`Seam: promoted '${name}' to the shared adapter store — reused across repos now.`);
  } catch (e) {
    vscode.window.showErrorMessage(`Seam: promote failed — ${e instanceof Error ? e.message : e}`);
  }
}

async function reviewCommit() {
  const ref = await vscode.window.showInputBox({
    prompt: "Commit / range to review (e.g. HEAD, a1b2c3d, main..HEAD)",
    value: "HEAD",
  });
  if (ref) runReview(ref.includes("..") ? ref : `${ref}~..${ref}`);
}

function buildIndex() {
  fileIndex = new Map();
  seamLabel = new Map();
  seamNeighbors = new Map();
  seamContractsByPartner = new Map();
  if (!model) return;
  for (const cl of model.clusters) for (const s of cl.seams) seamLabel.set(s.id, s.label);
  for (const e of model.seamEdges ?? []) {
    (seamNeighbors.get(e.from) ?? seamNeighbors.set(e.from, []).get(e.from)!).push({ id: e.to, provenance: e.provenance });
    (seamNeighbors.get(e.to) ?? seamNeighbors.set(e.to, []).get(e.to)!).push({ id: e.from, provenance: e.provenance });
  }
  // Index each contract under BOTH its seams (keyed by the partner), so either seam can inline it.
  for (const c of model.seamContracts ?? []) {
    (seamContractsByPartner.get(c.seamA) ?? seamContractsByPartner.set(c.seamA, new Map()).get(c.seamA)!).set(c.seamB, c);
    (seamContractsByPartner.get(c.seamB) ?? seamContractsByPartner.set(c.seamB, new Map()).get(c.seamB)!).set(c.seamA, c);
  }
  const add = (e: IndexEntry) => {
    const list = fileIndex.get(e.hunk.file) ?? [];
    list.push(e);
    fileIndex.set(e.hunk.file, list);
  };
  for (const cl of model.clusters)
    for (const s of cl.seams)
      for (const h of s.hunks) add({ hunk: h, seamId: s.id, seamLabel: s.label, intent: cl.intent });
  for (const h of model.tests) add({ hunk: h, seamId: "", seamLabel: "test", intent: "" });
  for (const h of model.noise) add({ hunk: h, seamId: "", seamLabel: "noise", intent: "" });
}

// Promisified execFile — reject carries the tool's stderr (the useful message).
// Human suffix for a Seam info message: "  ·  9.2k tokens, $0.0123, 23s". Empty when no metered
// LLM call ran (deterministic / host-served / copilot runs carry no usage).
function usageNote(u?: Usage): string {
  if (!u || !u.calls) return "";
  const tok = u.total_tokens
    ? `${(u.total_tokens / 1000).toFixed(1)}k tokens`
    : `${u.calls} LLM call${u.calls === 1 ? "" : "s"}`;
  const cost = u.cost_usd ? `, $${u.cost_usd.toFixed(4)}` : "";
  const secs = u.duration_ms ? `, ${Math.round(u.duration_ms / 1000)}s` : "";
  return `  ·  ${tok}${cost}${secs}`;
}

function execFileP(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env: engineEnv(), maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

// Marker the engine writes to stderr at each phase boundary (ts/src/core/progress.ts).
// A long decompose spends ~2 min inside two LLM passes with no output, so we stream stderr,
// strip this prefix, and surface the message live in the progress notification.
const PROGRESS_PREFIX = "@@SEAM_PROGRESS@@";

// Like execFileP but spawns so stderr can be read live: each PROGRESS_PREFIX line is handed to
// `onProgress` as the next phase message. Still buffers stderr for the error message on failure.
function runStreaming(file: string, args: string[], cwd: string,
              onProgress?: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: engineEnv() });
    let stderr = "";
    let buf = "";
    child.stdout.on("data", () => { /* drain (output is a tiny "Seams: path" line) */ });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      buf += text;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const i = line.indexOf(PROGRESS_PREFIX);
        if (i >= 0) onProgress?.(line.slice(i + PROGRESS_PREFIX.length).trim());
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `the engine exited with code ${code}`));
    });
  });
}

// One recorded LLM pass from the engine's `--emit-prompts` (see ts/src/core/llm.ts HostBus).
interface RecordedPass { tag: string; prompt: string; model: string; thinking: number | null; }

// Decompose by serving the engine's LLM passes from VS Code's own language model (the `copilot`
// backend), instead of shelling a `claude`/`copilot` CLI. Same two-phase host-bus handshake the MCP
// server uses (mcp/src/sampling.ts): emit-prompts → call the model per pass → inject-llm → emit-seams.
// `baseArgs` select the input + engine (e.g. --git RANGE --repo R --cluster llm --roles det …) WITHOUT
// any --emit-prompts/--inject-llm/--emit-seams. Throws an actionable error when no model is available
// or a single pass exceeds the model's input window (the big-PR ceiling).
async function decomposeViaVscodeLm(baseArgs: string[], out: string, run: string, cwd: string,
                                    report: (m: string) => void, token: vscode.CancellationToken): Promise<void> {
  const stamp = Date.now();
  const promptsPath = path.join(cwd, `.seam-prompts-${stamp}.json`);
  const answersPath = path.join(cwd, `.seam-answers-${stamp}.json`);
  try {
    report("Preparing LLM passes…");
    await runStreaming(run, [...baseArgs, "--emit-prompts", promptsPath], cwd);
    const passes: RecordedPass[] = JSON.parse(fs.readFileSync(promptsPath, "utf-8")).passes ?? [];
    if (!passes.length) {                       // nothing LLM to serve (e.g. det) — straight through
      await runStreaming(run, [...baseArgs, "--emit-seams", out], cwd, report);
      return;
    }
    const picked = await lm.selectBestModel();
    if (!picked)
      throw new Error("No language model available through VS Code. Enable GitHub Copilot (or another "
        + "Language Model provider), or set seam.llmBackend to \"cli\" to use a claude/copilot CLI.");
    report(`Model: ${picked.name} (${(picked.maxInputTokens / 1000).toFixed(0)}K ctx)`);
    const answers: Record<string, string> = {};
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      const need = await lm.countTokens(picked, p.prompt, token);
      if (need > picked.maxInputTokens)
        throw new Error(`This change is too large for ${picked.name}: the “${p.tag}” pass needs `
          + `~${(need / 1000).toFixed(0)}K tokens but the model allows ${(picked.maxInputTokens / 1000).toFixed(0)}K. `
          + "Review a smaller range, or set seam.llmBackend=\"cli\" and use Claude Code (≈200K).");
      report(`LLM pass ${i + 1}/${passes.length}: ${p.tag}…`);
      answers[p.tag] = await lm.completeText(picked, p.prompt, token);   // sequential: passes can depend
    }
    fs.writeFileSync(answersPath, JSON.stringify({ answers }));
    report("Building seams…");
    await runStreaming(run, [...baseArgs, "--inject-llm", answersPath, "--emit-seams", out], cwd);
  } finally {
    for (const f of [promptsPath, answersPath]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

function llmBackend(): string {
  return vscode.workspace.getConfiguration("seam").get<string>("llmBackend") || "cli";
}

// The single entry point both diff and codebase mode use to run a decomposition. `flags` are all engine
// flags EXCEPT --emit-seams (added here → `out`); they MAY include --emit-graph (codebase mode — phase 2
// writes both). When the engine runs LLM passes (`useLlm`) and the `copilot` backend is selected, this
// serves those passes through VS Code's model (two-phase host-bus); otherwise one CLI run that locates a
// claude/copilot binary. `hostBusable=false` forces the CLI even under copilot — for invocations whose
// LLM work happens OUTSIDE the single host-bus pass (e.g. --auto's multi-step orchestration), which the
// one-shot --emit-prompts/--inject-llm handshake cannot capture.
async function runDecompose(flags: string[], out: string, useLlm: boolean, cwd: string,
                            report: (m: string) => void, token: vscode.CancellationToken,
                            hostBusable = true): Promise<void> {
  const run = engine().run;
  const baseArgs = [engineEntry("decompose"), ...flags];
  if (useLlm && llmBackend() === "copilot") {
    if (!hostBusable)
      throw new Error("This command makes multi-step LLM calls that VS Code's language model can't serve "
        + "in one pass. Set seam.llmBackend to \"cli\" (Claude Code / copilot CLI), or seam.engine to \"det\".");
    await decomposeViaVscodeLm(baseArgs, out, run, cwd, report, token);
  } else {
    await runStreaming(run, [...baseArgs, "--emit-seams", out], cwd, report);
  }
}

// Engine "ast" (deterministic + VS Code AST facts): ask the engine for the hunk skeleton
// (so facts are keyed by the SAME ids), compute defines/enclosing from the language
// server, write the partial facts payload, and return its path (for `--facts`). Returns
// undefined on any failure — the caller then runs deterministic with the regex base.
// `emitHunks` runs the TS CLI `--emit-hunks` into skelPath,
// so the editor's DocumentSymbol facts are keyed by the SAME hunk ids either pipeline assigns.
async function buildAstFacts(tool: string, emitHunks: (skelPath: string) => Promise<void>): Promise<string | undefined> {
  const skelPath = path.join(tool, `.seam-hunks-${Date.now()}.json`);
  try {
    await emitHunks(skelPath);
    const skel = JSON.parse(fs.readFileSync(skelPath, "utf-8")).hunks as
      { id: string; file: string; start: number; end: number }[];
    const payload = await computeSymbolFacts(repoRoot, skel);
    const factsPath = path.join(tool, `.seam-facts-${Date.now()}.json`);
    fs.writeFileSync(factsPath, JSON.stringify(payload), "utf-8");
    return factsPath;
  } catch {
    return undefined;
  } finally {
    try { fs.unlinkSync(skelPath); } catch { /* ignore */ }
  }
}

async function runReview(range: string, submodules = false) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showErrorMessage("Seam: open a folder/repo first."); return; }
  repoRoot = folder.uri.fsPath;
  const tool = toolPath();
  // Engine: "hybrid" (default — LLM clusters + product-intent labels, deterministic roles/wiring,
  // fed VS Code AST facts; needs a `claude` CLI), "det" (fully deterministic, offline, zero setup),
  // or "llm" (all LLM). Roles are deterministic in det/hybrid; only "llm" classifies roles by LLM.
  const engineMode = vscode.workspace.getConfiguration("seam").get<string>("engine") || "hybrid";
  const missing = engineMissing();
  if (missing) { vscode.window.showErrorMessage(missing); return; }
  const run = engine().run;
  // Codebase context (on by default): resolve the diff's references against the real repo so the
  // review shows blast radius (who outside the diff consumes a changed symbol). The LSP daemon stays
  // warm across reviews, so 'auto' (floor + LSP) is the right default here.
  const resolver = vscode.workspace.getConfiguration("seam").get<string>("resolver") || "det";
  const blastRadius = vscode.workspace.getConfiguration("seam").get<boolean>("blastRadius") ?? true;
  // How LLM passes are served: "cli" (a claude/copilot CLI the engine locates) or "copilot" (borrow a
  // model through VS Code's Language Model API — no install). Only matters when the engine runs LLM
  // passes (hybrid/llm); 'det' needs no backend.
  const backend = vscode.workspace.getConfiguration("seam").get<string>("llmBackend") || "cli";
  // Review impact (the diff↔codebase bridge): after the base seams paint, annotate each with what the
  // change touches BEYOND the PR — transitive consumers + cross-stack data-flow readers in untouched
  // files, graded by the deterministic relevance floor. On by default; the pass is offline/deterministic
  // unless triage is enabled (an LLM round-trip over the floor's `unknown` residual only).
  const reviewImpact = vscode.workspace.getConfiguration("seam").get<boolean>("reviewImpact") ?? true;
  const reviewTriage = vscode.workspace.getConfiguration("seam").get<boolean>("reviewImpactTriage") ?? false;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: decomposing ${range}…`, cancellable: true },
    async (progress, token) => {
      const out = path.join(tool, `.seam-${Date.now()}.json`);
      const classified = path.join(tool, `.seam-classified-${Date.now()}.json`);   // phase-1 hunks, reused by impact
      let factsPath: string | undefined;
      const ts = Date.now();
      try {
        // 'det' = fully offline; 'hybrid' (the default) = LLM clusters + deterministic roles/wiring;
        // 'llm' = all-LLM. The deterministic roles are fed the editor's AST facts (defines/enclosing)
        // via --emit-hunks + --facts.
        const engineArgs = engineMode === "det" ? ["--classifier", "det"]
          : engineMode === "llm" ? ["--classifier", "llm"]
          : ["--cluster", "llm", "--roles", "det", "--wiring", "hybrid"];   // hybrid
        if (engineMode !== "llm") {               // det/hybrid use deterministic roles → AST facts help
          progress.report({ message: "Computing code facts…" });
          factsPath = await buildAstFacts(tool, (skel) => runStreaming(run,
            [engineEntry("decompose"), "--git", range, "--repo", repoRoot,
             ...(submodules ? ["--submodules"] : []), "--emit-hunks", skel], tool));
        }
        // PHASE 1 — classify the diff and paint the base seams. --dump-classified persists the classified
        // hunks so the impact pass (phase 2) reuses them deterministically (no second LLM classification).
        // Blast radius (who outside the diff consumes a changed symbol). --resolver auto|lsp drives the
        // headless language server (warm daemon) with the deterministic floor as fallback. --submodules
        // also folds each git submodule's working diff in (paths prefixed by the submodule dir).
        const flags = ["--git", range, "--repo", repoRoot, ...engineArgs,
                       ...(submodules ? ["--submodules"] : []),
                       ...(factsPath ? ["--facts", factsPath] : []),
                       ...(resolver !== "det" ? ["--resolver", resolver] : []),
                       ...(blastRadius ? ["--blast-radius"] : []),
                       ...(reviewImpact ? ["--dump-classified", classified] : [])];
        // copilot backend serves the LLM passes through VS Code's model; det/cli run as one CLI call.
        await runDecompose(flags, out, engineMode !== "det", tool, (m) => progress.report({ message: m }), token);
        const parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        if (reviewImpact) annotatingImpact = true;     // tells the tree the impact pass is coming
        activateModel(parsed, repoRoot, range, ts);
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        const via = engineMode !== "det" && backend === "copilot" ? " · via Copilot" : "";
        vscode.window.showInformationMessage(
          `Seam (${engineMode}${via}): ${parsed.clusters.length} clusters, ${n} seams.${usageNote(parsed.usage)}  ` +
          `core=amber · link=blue · environment=gray · test=green · noise=faint`);

        // PHASE 2 — annotate review impact over the SAME classification (no re-classify, so seams don't
        // reshuffle): the diff↔codebase bridge (transitive consumers + cross-stack data-flow in untouched
        // files), graded by the relevance floor. Deterministic unless triage is on (an LLM pass over the
        // `unknown` residual only). Failures are non-fatal — the base review stays.
        if (reviewImpact && fs.existsSync(classified)) {
          progress.report({ message: "Annotating impact (blast radius + cross-stack)…" });
          const impactFlags = ["--from-classified", classified, "--review-impact", "--repo", repoRoot,
                               ...(blastRadius ? ["--blast-radius"] : []),
                               ...(resolver !== "det" ? ["--resolver", resolver] : []),
                               ...(reviewTriage ? ["--triage"] : [])];
          try {
            // triage is the only LLM work here; the floor + bridge are deterministic (useLlm only when triaging).
            await runDecompose(impactFlags, out, reviewTriage, tool, (m) => progress.report({ message: m }), token);
            const withImpact = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
            annotatingImpact = false;
            activateModel(withImpact, repoRoot, range, ts);
            extContext.workspaceState.update(STATE_KEY, { model: withImpact, repoRoot, range, ts } as SavedRun);
          } catch (e) {
            process.stderr?.write?.(`review-impact skipped: ${e instanceof Error ? e.message : e}\n`);
          }
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Seam failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        annotatingImpact = false;
        treeProvider.refresh();                        // clear any lingering loader if phase 2 threw
        for (const f of [out, classified]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
        if (factsPath) { try { fs.unlinkSync(factsPath); } catch { /* ignore */ } }
      }
    },
  );
}

// CODEBASE MODE (plan §3): decompose from an ANCHOR (a symbol, or a whole module) instead of a
// diff. Consumer discovery is the deterministic import scan (the TS CLI `--scan` — monorepo-safe,
// offline; LSP find-references is project-scoped/blind, see resolver.ts). The SAME native renderer
// paints the SeamModel; the engine never sees `vscode` (constraint §4).

// Shared env guard: workspace folder + the TS CLI. Sets repoRoot; null (after an error message) if
// anything is missing.
function codebaseEnv(): { tool: string } | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showErrorMessage("Seam: open a folder/repo first."); return null; }
  repoRoot = folder.uri.fsPath;
  const tool = toolPath();
  const missing = engineMissing();
  if (missing) { vscode.window.showErrorMessage(missing); return null; }
  return { tool };
}

// Run `--scan` with the given anchor args (single-symbol or whole-module) and paint the result.
// --classifier (seam.engine) decides the partition: 'det' = floor only; 'hybrid'/'llm' = LLM-refined
// intent labels (proposed).
async function runScan(tool: string, scanArgs: string[], title: string, range: string) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const out = path.join(tool, `.seam-${Date.now()}.json`);
      const graph = path.join(tool, SESSION_GRAPH);   // P2: persisted ResolvedGraph for expansion
      const report = (m: string) => progress.report({ message: m });
      const auto = scanArgs.includes("--auto");        // --auto's grow is multi-step LLM (CLI-only)
      const intentIdx = scanArgs.indexOf("--intent");
      const intent = intentIdx >= 0 ? scanArgs[intentIdx + 1] : undefined;
      // Scan flags WITHOUT the classifier (added per phase below).
      const base = ["--scan", "--repo", repoRoot, ...scanArgs];
      // BIDIRECTIONAL (opt-in): a single-symbol footprint can include the anchor's DEPENDENCIES (the
      // backward "how it works" slice), not just its consumers — so a cross-cutting POLICY shows its
      // mechanism, and the engine can tell policy from flow. Only for a single symbol (not module/auto).
      if (vscode.workspace.getConfiguration("seam").get<boolean>("bidirectional")
          && scanArgs.includes("--symbol") && !auto)
        base.push("--bidirectional");
      // AFFINITY (opt-in, intent-driven only): the deep "what else relates to this intent" pass. The
      // engine no-ops it without an --intent, so it's safe to always append when enabled.
      if (vscode.workspace.getConfiguration("seam").get<boolean>("affinity") && intent)
        base.push("--affinity");

      const engineCfg = vscode.workspace.getConfiguration("seam").get<string>("engine") || "hybrid";
      // Two-step reveal: paint the deterministic skeleton first, then enrich it in place. Only worth it
      // when an LLM enrichment pass actually follows (hybrid/llm) and the user hasn't opted out.
      const twoStep = engineCfg !== "det"
        && (vscode.workspace.getConfiguration("seam").get<boolean>("progressiveReveal") ?? true);

      // Paint + persist a result; `range` and `ts` stay constant across both phases so the swap reads as
      // the SAME run being enriched, not a new run.
      const ts = Date.now();
      const paint = (parsed: SeamModel) => {
        if (auto) parsed.autoGrown = true;             // the --graph enrich pass doesn't re-stamp this
        sessionGraph = graph;                          // fresh analysis = new session to grow from
        activateModel(parsed, repoRoot, range, ts);
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
      };
      const toast = (parsed: SeamModel) => {
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        vscode.window.showInformationMessage(
          `Seam (codebase): ${range} — ${parsed.clusters.length} cluster(s), ${n} seam(s).${usageNote(parsed.usage)}`);
      };

      try {
        if (!twoStep) {
          // SINGLE PASS — 'det' (offline) or progressive reveal off (wait for the full result).
          // --auto orchestrates multiple LLM steps outside the host-bus pass → CLI-only (hostBusable=false).
          await runDecompose([...base, "--classifier", engineCfg, "--emit-graph", graph],
            out, engineCfg !== "det", tool, report, token, !auto);
          const parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
          paint(parsed); toast(parsed);
          return;
        }
        // PHASE 1 — the deterministic skeleton (spine + structural labels + blind spots), painted now.
        // Static scan: fully offline & instant ('det', no LLM). --auto: the grow still runs (it IS the
        // footprint), but `--skeleton` skips the ~18s seam-intent naming/tiering pass for this phase.
        report(auto ? "Growing the footprint…" : "Building the structure…");
        const p1 = auto ? [...base, "--classifier", engineCfg, "--skeleton", "--emit-graph", graph]
                        : [...base, "--classifier", "det", "--emit-graph", graph];
        await runDecompose(p1, out, auto && engineCfg !== "det", tool, report, token, !auto);
        const skel = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        enriching = true;
        paint(skel);
        // PHASE 2 — enrich over the SAME graph (no re-scan/re-grow): the LLM names the seams + tiers them
        // spine/supporting/off. --graph is a single host-bus pass (copilot-serveable; hostBusable=true).
        report("Naming & ranking with the LLM…");
        const p2 = ["--graph", graph, "--classifier", engineCfg, ...(intent ? ["--intent", intent] : [])];
        await runDecompose(p2, out, true, tool, report, token, true);
        const full = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        enriching = false;
        paint(full); toast(full);
      } catch (e) {
        vscode.window.showErrorMessage(`Seam codebase analysis failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        enriching = false;
        treeProvider.refresh();                        // clear any lingering loader if phase 2 threw
        try { fs.unlinkSync(out); } catch { /* ignore */ }
      }
    },
  );
}

// SINGLE-SYMBOL anchor: the symbol under the cursor (LSP `documentSymbols` names it — single-file,
// reliable), then scan its consumers.
async function analyzeCodebase() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("Seam: open a file and put the cursor on a class or method first.");
    return;
  }
  const env = codebaseEnv();
  if (!env) return;
  const anchor = await anchorSymbolAt(new VSCodeSymbolResolver(), editor.document.uri, editor.selection.active, repoRoot);
  if (!anchor) {
    vscode.window.showErrorMessage(
      "Seam: couldn't identify a symbol here. Put the cursor on a class/function/method name " +
      "and wait for the language server to finish indexing.");
    return;
  }
  // depth 2 (default) adds the environment ripple = the boundary frontier (consumers-of-consumers).
  sessionIntent = "";                      // a cursor-anchored analysis has no question to focus on
  const depth = vscode.workspace.getConfiguration("seam").get<number>("codebaseDepth") ?? 2;
  if (anchor.kind === "class") {
    // A class anchor splits by METHOD: the LSP verifies which method each consumer calls (the
    // precision path), with the tree-sitter heuristic as the degrade fallback. Both backends emit
    // candidates (--emit-candidates) and rebuild with the verified attribution (--attribution).
    await runScanClass(env.tool, anchor, depth);
  } else {
    await runScan(env.tool,
                  ["--anchor-file", anchor.file, "--symbol", anchor.symbol, "--depth", String(depth)],
                  `Seam: scanning consumers of ${anchor.symbol}…`, `anchor ${anchor.symbol}`);
  }
}

// CLASS anchor — the LSP-verified method-attribution flow (3 phases): (1) the engine emits the method
// call-site candidates; (2) the LSP go-to-defs each to confirm it binds to the anchor class; (3)
// the engine rebuilds with the verified attribution (RESOLVED_FULL). If the LSP confirms nothing
// (no provider / mid-indexing), it falls back to the tree-sitter heuristic (RESOLVED_PARTIAL).
async function runScanClass(tool: string,
                            anchor: { symbol: string; file: string }, depth: number, intent?: string) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: resolving methods of ${anchor.symbol}…`, cancellable: true },
    async (progress, token) => {
      const cand = path.join(tool, `.seam-cand-${Date.now()}.json`);
      const attr = path.join(tool, `.seam-attr-${Date.now()}.json`);
      const out = path.join(tool, `.seam-${Date.now()}.json`);
      try {
        const engineCfg = vscode.workspace.getConfiguration("seam").get<string>("engine") || "hybrid";
        const base = ["--scan", "--repo", repoRoot, "--anchor-file", anchor.file, "--symbol", anchor.symbol];
        // phase 1 — candidates
        progress.report({ message: "Finding method call-sites…" });
        await execFileP(...decomposeInvocation(tool, [...base, "--emit-candidates", cand]), tool);
        const candidates = JSON.parse(fs.readFileSync(cand, "utf-8")) as MethodCandidate[];
        // phase 2 — LSP verify
        progress.report({ message: "Verifying call-sites with the language server…" });
        const verified = await verifyMethodAttribution(new VSCodeSymbolResolver(), candidates, anchor.file, repoRoot);
        const scanArgs = ["--depth", String(depth)];
        if (intent) scanArgs.push("--intent", intent);
        const nVerified = Object.values(verified).reduce((a, m) => a + Object.keys(m).length, 0);
        if (nVerified > 0) {
          fs.writeFileSync(attr, JSON.stringify(verified), "utf-8");
          scanArgs.push("--attribution", attr);     // else: fall back to the heuristic
        }
        // phase 3 — decompose with the verified (or heuristic) attribution
        const graph = path.join(tool, SESSION_GRAPH);
        await runDecompose([...base, ...scanArgs, "--classifier", engineCfg, "--emit-graph", graph],
          out, engineCfg !== "det", tool, (m) => progress.report({ message: m }), token);
        const parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        sessionGraph = graph;
        const ts = Date.now();
        const range = `class ${anchor.symbol}`;
        activateModel(parsed, repoRoot, range, ts);
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        const how = nVerified > 0 ? `${nVerified} method call(s) LSP-verified` : "heuristic (no LSP)";
        vscode.window.showInformationMessage(
          `Seam (codebase): ${anchor.symbol} — ${parsed.clusters.length} cluster(s), ${n} seam(s).  ${how}.`);
      } catch (e) {
        vscode.window.showErrorMessage(`Seam class analysis failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        for (const f of [cand, attr, out]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      }
    },
  );
}

// MODULE anchor: the WHOLE active file — every export is a carrier, partitioned by member
// co-occurrence (the §11.1 multi-member intent view). No symbol/cursor needed; omitting --symbol
// puts the TS CLI --scan into module mode.
async function analyzeModule() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showErrorMessage("Seam: open the module file you want to analyse first."); return; }
  const env = codebaseEnv();
  if (!env) return;
  const file = path.relative(repoRoot, editor.document.uri.fsPath).split(path.sep).join("/");
  const base = path.basename(file);
  sessionIntent = "";
  await runScan(env.tool, ["--anchor-file", file],
                `Seam: scanning module ${base}…`, `module ${base}`);
}

// P2/P3: EXPAND from a node — scan its footprint and MERGE it into the session graph, growing the
// intent that direction. UP (default) = its consumers; DOWN = its dependencies (service→repo→db).
// Re-applies the persisted question to re-focus. Invoked from the tree's context menu (it receives
// the hunk Node).
async function expandFrom(node: { hunk?: SeamHunk } | undefined, down: boolean, crossNote?: string) {
  const h = node?.hunk;
  if (!h) return;
  if (!sessionGraph || !fs.existsSync(sessionGraph)) {
    vscode.window.showErrorMessage("Seam: run an analysis first, then expand a node.");
    return;
  }
  const symbol = h.label;
  if (!symbol) {
    vscode.window.showWarningMessage("Seam: this node has no symbol to expand from.");
    return;
  }
  const env = codebaseEnv();
  if (!env) return;
  const depth = vscode.workspace.getConfiguration("seam").get<number>("codebaseDepth") ?? 2;
  const before = nodeCount(model);
  const dir = down ? "dependencies of" : "consumers of";
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: expanding to the ${dir} ${symbol}…`, cancellable: true },
    async (progress, token) => {
      const out = path.join(env.tool, `.seam-${Date.now()}.json`);
      try {
        const engineCfg = vscode.workspace.getConfiguration("seam").get<string>("engine") || "hybrid";
        // read the session graph AND write the grown one back to it (decompose loads before writing)
        const flags = ["--expand-graph", sessionGraph!, "--repo", repoRoot,
                       "--expand-file", h.file, "--expand-symbol", symbol, "--expand-line", String(h.start),
                       "--depth", String(depth), "--classifier", engineCfg, "--emit-graph", sessionGraph!];
        if (down) flags.push("--down");
        if (crossNote) flags.push("--cross-from", crossNote);
        if (sessionIntent) flags.push("--intent", sessionIntent);
        // NB: expand DOWN (dependencies) discovers the graph with an LLM call that runs OUTSIDE the
        // host-bus pass, so under the copilot backend that step still needs a CLI; expand UP (consumers)
        // is fully served via vscode.lm.
        await runDecompose(flags, out, engineCfg !== "det", env.tool,
          (m) => progress.report({ message: m }), token);
        const parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        const ts = Date.now();
        const range = `expanded ${down ? "↓" : "+"}${symbol}`;
        activateModel(parsed, repoRoot, range, ts);
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        if (nodeCount(parsed) <= before) {
          vscode.window.showInformationMessage(
            `Seam: nothing new reached ${down ? "below" : "above"} ${symbol} — a dead-end ` +
            `(${down ? "no resolvable dependencies" : "no by-name consumers, e.g. a router endpoint"}).`);
        } else {
          vscode.window.showInformationMessage(`Seam: grew the intent ${down ? "downward" : ""} from ${symbol} — ${n} seam(s) now.`);
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Seam expand failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        try { fs.unlinkSync(out); } catch { /* ignore */ }
      }
    },
  );
}

function nodeCount(m?: SeamModel): number {
  if (!m) return 0;
  const ids = new Set<string>();
  for (const cl of m.clusters) for (const s of cl.seams) for (const h of s.hunks) ids.add(h.id);
  return ids.size;
}

const expandNode = (node?: { hunk?: SeamHunk }) => expandFrom(node, false);   // UP: consumers (importers + call-sites)
const expandDown = (node?: { hunk?: SeamHunk }) => expandFrom(node, true);    // DOWN: dependencies

// P4: CROSS a layer boundary by SUGGESTED symbol-match. When resolved expansion stops at an
// abstraction/DI symbol (an interface, a DI token), find related in-repo impls and let the user
// pick one to continue through — recorded as an ASSUMPTION (a suggested-crossing blind spot), then
// the picked target's footprint is RESOLVED.
async function crossBoundary(node?: { hunk?: SeamHunk }) {
  const h = node?.hunk;
  if (!h || !h.label) return;
  const env = codebaseEnv();
  if (!env) return;
  const symbol = h.label;
  let targets: Array<{ name: string; file: string; kind: string }> = [];
  const out = path.join(env.tool, `.seam-cross-${Date.now()}.json`);
  try {
    await execFileP(...anchorRankInvocation(env.tool,
      ["--crossings", "--intent", symbol, "--repo", repoRoot, "--exclude-file", h.file, "--out", out]), env.tool);
    targets = JSON.parse(fs.readFileSync(out, "utf-8"));
  } catch (e) {
    vscode.window.showErrorMessage(`Seam: crossing search failed: ${e instanceof Error ? e.message : e}`);
    return;
  } finally {
    try { fs.unlinkSync(out); } catch { /* ignore */ }
  }
  if (!targets.length) {
    vscode.window.showInformationMessage(`Seam: no in-repo crossing found for ${symbol} (a terminal/external boundary).`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    targets.map((t) => ({ label: t.name, description: `${t.kind} · suggested crossing`, detail: t.file, t })),
    { title: `Cross from ${symbol} to… (a symbol-match assumption)`, matchOnDetail: true, ignoreFocusOut: true },
  );
  if (!pick) return;
  const synthetic = { hunk: { id: "", file: pick.t.file, label: pick.t.name, start: 0, end: 0, role: "" } as SeamHunk };
  await expandFrom(synthetic, false, `crossed from ${symbol} → ${pick.t.name} (symbol-match assumption, unverified)`);
}

// LLM capability probe, cached per session. Runs `anchor_rank --llm-probe`, which makes NO LLM call
// (it only checks for a resolvable claude/copilot binary). Gates the "Search with the LLM…" item and
// the empty-result auto-fallback so neither is ever a dead end on a pure-offline install.
let llmProbeCache: boolean | undefined;
async function llmAvailable(env: { tool: string }): Promise<boolean> {
  if (llmProbeCache !== undefined) return llmProbeCache;
  const out = path.join(env.tool, `.seam-llmprobe-${Date.now()}.json`);
  try {
    await execFileP(...anchorRankInvocation(env.tool, ["--llm-probe", "--out", out]), env.tool);
    llmProbeCache = JSON.parse(fs.readFileSync(out, "utf-8"))?.llm === true;
  } catch { llmProbeCache = false; } finally {
    try { fs.unlinkSync(out); } catch { /* ignore */ }
  }
  return llmProbeCache;
}

type AnchorItem = { name: string; file: string; kind: string; terms?: string[] };
// The deterministic anchor ranker, optionally widened by LLM query-expansion (`--llm-expand`:
// the LLM proposes extra keywords, still grounded by the deterministic repo scan).
async function rankAnchors(env: { tool: string }, intent: string, llm: boolean): Promise<AnchorItem[]> {
  const ranked = path.join(env.tool, `.seam-rank-${Date.now()}.json`);
  try {
    const args = ["--intent", intent, "--repo", repoRoot, "--out", ranked];
    if (llm) args.push("--llm-expand");
    await execFileP(...anchorRankInvocation(env.tool, args), env.tool);
    return JSON.parse(fs.readFileSync(ranked, "utf-8"));
  } finally {
    try { fs.unlinkSync(ranked); } catch { /* ignore */ }
  }
}

// Sentinel: the user chose the "Search with the LLM…" item instead of a concrete anchor.
const LLM_RESEARCH = Symbol("llm-research");
type PickedAnchor = { symbol: string; file: string; kind: string };
async function pickAnchor(items: AnchorItem[], intent: string, offerLlm: boolean):
    Promise<PickedAnchor | typeof LLM_RESEARCH | undefined> {
  type Pick = vscode.QuickPickItem & { anchor?: PickedAnchor; research?: boolean };
  const picks: Pick[] = items.map((c) => ({
    label: c.name,
    description: c.kind,
    detail: c.file + (c.terms?.length ? `   · matched: ${c.terms.join(", ")}` : ""),
    anchor: { symbol: c.name, file: c.file, kind: c.kind },
  }));
  // The LLM escape hatch sits LAST so the best deterministic candidate stays the default selection.
  if (offerLlm) picks.push({ label: "$(sparkle) Search with the LLM…", description: "Expand the intent with the LLM and re-search", research: true });
  const pick = await vscode.window.showQuickPick(picks, {
    title: `Anchors for “${intent}” — pick one to map its footprint`, matchOnDetail: true, ignoreFocusOut: true,
  });
  if (!pick) return undefined;
  return pick.research ? LLM_RESEARCH : pick.anchor;
}

// FUZZY ENTRY RAMP (plan P3): describe an intent → deterministic repo-scan candidates → the engine
// ranks them (optionally widened by LLM query-expansion) → the user CONFIRMS one → the deterministic
// footprint attaches to the confirmed anchor (the brief's invariant: the guarantee attaches only
// AFTER confirmation, never from an unconfirmed match).
async function analyzeFromIntent(auto = false) {
  const env = codebaseEnv();
  if (!env) return;
  const intent = await vscode.window.showInputBox({
    title: "Seam: find a footprint by intent",
    prompt: "Describe the feature or symbol you want to map",
    placeHolder: "e.g. how does scoring work · how are roles saved · availability",
    ignoreFocusOut: true,
  });
  if (!intent || !intent.trim()) return;
  sessionIntent = intent;                  // persist the question so expansions re-focus the answer

  if (auto) {
    // AUTO MAP: no manual pick. The engine SELECTS the anchor (structural probe floor drops candidates
    // whose footprint dead-ends; an LLM judges which connected footprint is the intent's entry point),
    // then grows from it — so a name-matching-but-isolated anchor can't be picked and hide the result.
    await runScan(env.tool,
                  ["--intent", intent, "--auto", "--max-steps", "3"],
                  `Seam: auto-mapping the footprint for “${intent}”…`, `auto · ${intent}`);
    return;
  }

  const noMatch = () => vscode.window.showWarningMessage(`Seam: no anchors matched “${intent}”. Try a keyword that appears in the code.`);
  const hasLlm = await llmAvailable(env);   // probe once (no LLM call) — gates the fallback + the LLM item
  const picked = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: finding anchors for “${intent}”…` },
    async (progress): Promise<PickedAnchor | undefined> => {
      // Candidate discovery is a DETERMINISTIC repo scan, not workspaceSymbol — the LSP
      // workspace-symbol search is project-scoped / depends on what's loaded (the same flakiness we
      // pivoted off for find-references), so it would miss symbols in unopened files.
      let items = await rankAnchors(env, intent, false);
      if (!items.length) {
        // Empty is a CRISP signal (stems matched nothing) → auto-fall back to LLM query-expansion
        // when a backend exists. The fuzzier weak-but-nonempty case is the manual item in pickAnchor.
        if (hasLlm) {
          progress.report({ message: "no static match — asking the LLM…" });
          items = await rankAnchors(env, intent, true);
        }
        if (!items.length) { noMatch(); return undefined; }
      }
      let anchor = await pickAnchor(items, intent, hasLlm);
      if (anchor === LLM_RESEARCH) {
        // User judged the static candidates wrong → widen with the LLM, then re-pick. No LLM item the
        // second time (it already ran), so there's no re-search loop.
        progress.report({ message: "searching with the LLM…" });
        const widened = await rankAnchors(env, intent, true);
        if (!widened.length) { noMatch(); return undefined; }
        anchor = await pickAnchor(widened, intent, false);
      }
      return anchor === LLM_RESEARCH ? undefined : anchor;
    },
  );
  if (!picked) return;

  const depth = vscode.workspace.getConfiguration("seam").get<number>("codebaseDepth") ?? 2;
  if (picked.kind === "class") {
    await runScanClass(env.tool, picked, depth, intent);   // intent focuses the matching seam
  } else {
    await runScan(env.tool,
                  ["--anchor-file", picked.file, "--symbol", picked.symbol, "--depth", String(depth),
                   "--intent", intent],
                  `Seam: scanning consumers of ${picked.symbol}…`, `anchor ${picked.symbol}`);
  }
}
const autoMapIntent = () => analyzeFromIntent(true);

// The two top-level engines, each behind ONE toolbar button: a QuickPick picks the
// seed so the title bar stays at three icons (detangle · map intent · clear) instead
// of one-button-per-entry-point. Cursor/module seeding stays in the editor right-click,
// where the cursor IS the context.
async function detangle() {
  const pick = await vscode.window.showQuickPick(
    [
      { id: "working", label: "$(git-commit) Working changes", description: "Decompose the working tree against HEAD" },
      { id: "working-sub", label: "$(git-commit) Working changes + submodules", description: "Working tree AND each git submodule's changes, decomposed as one" },
      { id: "commit", label: "$(git-branch) A commit…", description: "Pick a commit or range to decompose" },
    ],
    { title: "Seam — detangle a diff", placeHolder: "What do you want to detangle?" },
  );
  if (!pick) return;
  if (pick.id === "working") return runReview("HEAD");
  if (pick.id === "working-sub") return runReview("HEAD", true);
  return reviewCommit();
}

async function mapIntent() {
  const pick = await vscode.window.showQuickPick(
    [
      { id: "auto", label: "$(sparkle) Describe an intent (auto-grow)", description: "The LLM grows the footprint from your description" },
      { id: "search", label: "$(search-fuzzy) Search for an anchor…", description: "Fuzzy-find a starting symbol, then map its footprint" },
    ],
    { title: "Seam — map an intent", placeHolder: "How do you want to seed the map?" },
  );
  if (!pick) return;
  return analyzeFromIntent(pick.id === "auto");
}

// Repo-relative path IF this document is the MODIFIED (new) side we should decorate:
// the working file (`file:`) or a diff's modified side (`git:` with empty ref =
// index/working). Returns null for the diff's BASE side (a `git:` commit ref like
// HEAD), whose old-side lines wouldn't match our new-side ranges.
function modifiedRelPath(uri: vscode.Uri): string | null {
  if (!repoRoot) return null;
  let fsPath: string | null = null;
  if (uri.scheme === "file") {
    fsPath = uri.fsPath;
  } else if (uri.scheme === "git") {
    try {
      const q = JSON.parse(uri.query || "{}");
      if (q.ref === "" || q.ref == null) fsPath = q.path || uri.fsPath; // modified side only
    } catch { /* not a parseable git: uri */ }
  }
  if (!fsPath) return null;
  return path.relative(repoRoot, fsPath).split(path.sep).join("/");
}

// --- decorations: paint each visible editor's changed lines with a calm role SPINE ---
// Show-all = the landscape: just the weight-coded spines, no wash, nothing dimmed. Focus = one
// seam reads richly (spine + barely-there wash) while the OTHER seams' changed lines fade back.
function applyDecorations(editor: vscode.TextEditor) {
  if (!model) return;
  const rel = modifiedRelPath(editor.document.uri);
  if (rel === null) return;
  const entries = fileIndex.get(rel) ?? [];
  const line = (n: number) => new vscode.Range(n, 0, n, 0);
  // Per editor line, the SET of roles covering it (across overlapping placements) — drives the
  // spine (split where >1 role). Only IN-FOCUS hunks contribute roles; out-of-focus changed
  // lines are collected to dim instead.
  const lineRoles: Map<number, Set<string>> = new Map();
  const dimLines = new Set<number>();
  for (const { hunk: h } of entries) {
    const inFocus = !focusIds || focusIds.has(spanKey(h));
    const s = Math.max(0, h.start - 1);
    const e = Math.max(s, h.end - 1);
    if (inFocus) {
      const role = ROLES.includes(h.role) ? h.role : "noise";
      for (let n = s; n <= e; n++) (lineRoles.get(n) ?? lineRoles.set(n, new Set()).get(n)!).add(role);
    } else {
      for (let n = s; n <= e; n++) dimLines.add(n);
    }
  }
  for (const n of lineRoles.keys()) dimLines.delete(n);   // a focused line wins over a dimmed one

  // SPINE (always) + FILL (focus only), both by role-combo: one spine per line (weight-coded;
  // split on overlap) and, in focus, a single BLENDED wash per line (never stacked). Clear
  // every previously-painted combo first so stale ones vanish on re-paint.
  const byCombo: Map<string, vscode.Range[]> = new Map();
  for (const [n, roles] of lineRoles) {
    const key = ROLES.filter((r) => roles.has(r)).join("|") || "noise";
    (byCombo.get(key) ?? byCombo.set(key, []).get(key)!).push(line(n));
  }
  for (const deco of decoSpine.values()) editor.setDecorations(deco, []);
  for (const deco of decoFill.values()) editor.setDecorations(deco, []);
  for (const [key, ranges] of byCombo) {
    const roles = key.split("|");
    editor.setDecorations(spineFor(roles), ranges);
    if (focusIds) editor.setDecorations(fillFor(roles), ranges);   // wash: focused seam only
  }
  // DIM the other seams' changed lines — fade the CODE (text range), not the spine, so they
  // recede yet stay locatable. Clamp to the live document in case the file drifted from the run.
  editor.setDecorations(decoDim,
    focusIds ? [...dimLines].filter((n) => n < editor.document.lineCount).map((n) => editor.document.lineAt(n).range) : []);

  // re-apply the selected proposed sub-core overlay (so it survives repaints / editor switches).
  editor.setDecorations(decoProposed,
    activeProposed && editor.document.uri.fsPath === activeProposed.filePath ? activeProposed.ranges : []);
}

function applyToVisible(editors: readonly vscode.TextEditor[]) { editors.forEach(applyDecorations); }

function clearAll() {
  model = undefined;
  fileIndex = new Map();
  resolveCache.clear();
  for (const editor of vscode.window.visibleTextEditors) {
    for (const d of comboDecos()) editor.setDecorations(d, []);
    editor.setDecorations(decoDim, []);
  }
  clearProposed();
  treeProvider?.refresh();
  lensProvider?.refresh();
  if (treeView) treeView.message = undefined;
  vscode.commands.executeCommand("setContext", "seam.active", false);
  vscode.commands.executeCommand("setContext", "seam.focused", false);
  extContext?.workspaceState.update(STATE_KEY, undefined);  // forget the cached run
}

// --- CodeLens: write "intent · seam label" on top of each hunk (click → focus it) ---
class SeamLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  refresh() { this._onDidChange.fire(); }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!model) return [];
    const rel = modifiedRelPath(doc.uri);
    if (rel === null) return [];
    const entries = fileIndex.get(rel) ?? [];
    const seenLabel = new Set<string>();
    const seenNav = new Set<number>();
    const seenUnc = new Set<number>();
    const seenRw = new Set<number>();
    const lenses: vscode.CodeLens[] = [];
    for (const e of entries) {
      if (focusIds && !focusIds.has(spanKey(e.hunk))) continue;
      const line = Math.max(0, e.hunk.start - 1);
      const r = new vscode.Range(line, 0, line, 0);
      // Uncertain-role marker (once per line): the role here is a maybe, not a fact.
      if (isUncertain(e.hunk) && !seenUnc.has(line)) {
        seenUnc.add(line);
        lenses.push(new vscode.CodeLens(r, {
          title: `$(question) ${e.hunk.role}? uncertain`,
          tooltip: `Role vote was split (confidence ${confPct(e.hunk)}%) — treat as a maybe`,
          command: "seam.open", arguments: [e.hunk],
        }));
      }
      // A->B rewire marker (once per line): "re-routes showToast → toastManager".
      const rw = rewireStr(e.hunk);
      if (rw && !seenRw.has(line)) {
        seenRw.add(line);
        lenses.push(new vscode.CodeLens(r, {
          title: `$(arrow-swap) ${rw}`,
          tooltip: "Re-routes A → B (read from this hunk's removed/added lines)",
          command: "seam.open", arguments: [e.hunk],
        }));
      }
      // The intent · seam label (one per seam membership), click → focus that seam.
      const lkey = `${line}:${e.seamId}`;
      if (!seenLabel.has(lkey)) {
        seenLabel.add(lkey);
        const title = e.intent ? `◆ ${e.seamLabel}  ·  ${e.intent}` : `◆ ${e.seamLabel}`;
        lenses.push(new vscode.CodeLens(r, { title, command: "seam.focusSeamById", arguments: [e.seamId] }));
      }
      // Inline prev/next, once per hunk line, navigating relative to THIS hunk.
      if (!seenNav.has(line)) {
        seenNav.add(line);
        lenses.push(new vscode.CodeLens(r, {
          title: "$(arrow-up)", tooltip: "Seam: previous hunk", command: "seam.prev", arguments: [spanKey(e.hunk)],
        }));
        lenses.push(new vscode.CodeLens(r, {
          title: "$(arrow-down)", tooltip: "Seam: next hunk", command: "seam.next", arguments: [spanKey(e.hunk)],
        }));
      }
    }
    return lenses;
  }
}

// --- open a hunk in DIFF mode (working-tree vs HEAD), revealed at its line ---
async function openHunk(hunk: SeamHunk) {
  if (!repoRoot) return;
  const uri = vscode.Uri.file(path.join(repoRoot, hunk.file));
  // Codebase mode opens a plain source file (no git change) and its line ranges are 0-based
  // (resolver/tree-sitter spans). Diff mode opens the native diff editor and its hunk lines are
  // 1-based. Branching on mode fixes both the jump (git.openChange leaves a diff editor whose uri
  // doesn't match, so the reveal was skipped) and the off-by-one.
  const codebase = model?.mode === "codebase";
  let editor: vscode.TextEditor | undefined;
  if (codebase) {
    editor = await vscode.window.showTextDocument(uri, { preview: true });
  } else {
    try {
      await vscode.commands.executeCommand("git.openChange", uri); // native diff editor
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
    editor = vscode.window.activeTextEditor;
  }
  if (editor && editor.document.uri.fsPath === uri.fsPath) {
    const line = Math.max(0, codebase ? hunk.start : hunk.start - 1);
    const range = new vscode.Range(line, 0, line, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);
  }
}

// Model B: reveal a PROPOSED sub-core — open the file (plain, no diff editor: codebase mode is
// not a change) and paint its ranges with the distinct dashed overlay. Opt-in (only the selected
// sub-core is painted), so the default view stays the verified structure (R-B3).
async function openSubcore(hunk: SeamHunk, sub: SubCore) {
  if (!repoRoot) return;
  const uri = vscode.Uri.file(path.join(repoRoot, hunk.file));
  const editor = await vscode.window.showTextDocument(uri, { preview: true });
  const ranges = sub.ranges.map(([a, b]) => new vscode.Range(a, 0, b, 0));
  activeProposed = { filePath: uri.fsPath, ranges };
  editor.setDecorations(decoProposed, ranges);
  if (ranges.length) editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenter);
}

function clearProposed() {
  activeProposed = null;
  for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(decoProposed, []);
}

// Model A: reveal a contract member's internal use (RESOLVED — a real reference, so a plain
// reveal/select, no "proposed" overlay).
async function openContract(hunk: SeamHunk, member: ContractMember) {
  if (!repoRoot || !member.ranges.length) return;
  const uri = vscode.Uri.file(path.join(repoRoot, hunk.file));
  const editor = await vscode.window.showTextDocument(uri, { preview: true });
  const [a, b] = member.ranges[0];
  const range = new vscode.Range(a, 0, b, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
}

// A2: jump to a consumer's feed site (where it passes a value to the anchor's prop).
async function openFeed(feed: ContractFeed) {
  if (!repoRoot) return;
  await openLocation(vscode.Uri.file(path.join(repoRoot, feed.from)), feed.line);
}

// Reveal a (uri, line) — used by A3's resolved feed definition.
async function openLocation(uri: vscode.Uri, line: number) {
  const editor = await vscode.window.showTextDocument(uri, { preview: true });
  const range = new vscode.Range(line, 0, line, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
}

// --- Layer 2: resolve an external coupling to WHERE it lives + its signature -----
// An unwired link wires to code OUTSIDE the diff (e.g. ToastProvider from @coss/ui).
// We don't BUILD codebase-awareness — we BORROW the editor's language services. A
// Resolver is pluggable: VsCodeResolver here; a filesystem/grep backend would
// implement the same interface for the standalone tool. Lazy (resolved only when a
// hunk is expanded), best-effort (degrades to symbol/source when nothing answers).
interface ExternalTarget {
  symbol: string;
  source: string;
  uri?: vscode.Uri;   // resolved definition file
  line?: number;      // 0-based line in that file
  detail?: string;    // signature / hover, first meaningful line
}
interface Resolver {
  resolve(ref: ExternalRef, hunk: SeamHunk): Promise<ExternalTarget>;
}

function findSymbolPosition(doc: vscode.TextDocument, symbol: string,
                            fromLine: number, toLine: number): vscode.Position | undefined {
  const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const last = Math.min(toLine, doc.lineCount - 1);
  for (let ln = Math.max(0, fromLine); ln <= last; ln++) {
    const m = re.exec(doc.lineAt(ln).text);
    if (m) return new vscode.Position(ln, m.index);
  }
  return undefined;
}

function normalizeLoc(d: vscode.Location | vscode.LocationLink): vscode.Location {
  const link = d as vscode.LocationLink;
  return link.targetUri ? new vscode.Location(link.targetUri, link.targetRange) : (d as vscode.Location);
}

function hoverText(hovers: vscode.Hover[] | undefined): string | undefined {
  for (const h of hovers ?? []) {
    for (const c of h.contents) {
      const raw = typeof c === "string" ? c : (c as vscode.MarkdownString).value ?? "";
      const line = raw.replace(/```[a-z]*\n?/gi, "").split("\n").map((x) => x.trim()).filter(Boolean)[0];
      if (line) return line.length > 120 ? line.slice(0, 117) + "…" : line;
    }
  }
  return undefined;
}

// Borrows VS Code's own definition + hover providers — no resolver of our own.
class VsCodeResolver implements Resolver {
  async resolve(ref: ExternalRef, hunk: SeamHunk): Promise<ExternalTarget> {
    const out: ExternalTarget = { symbol: ref.symbol, source: ref.source };
    try {
      const uri = vscode.Uri.file(path.join(repoRoot, hunk.file));
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = findSymbolPosition(doc, ref.symbol, hunk.start - 1, hunk.end - 1);
      if (!pos) return out;
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider", uri, pos);
      if (defs && defs.length) {
        const loc = normalizeLoc(defs[0]);
        out.uri = loc.uri;
        out.line = loc.range.start.line;
      }
      out.detail = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider", uri, pos));
    } catch { /* best-effort: degrade to symbol/source only */ }
    return out;
  }
}

const resolver: Resolver = new VsCodeResolver();
// hunk.id -> resolved targets (lazy, on expand). Cleared on new/cleared run.
const resolveCache = new Map<string, Promise<ExternalTarget[]>>();
const MAX_RESOLVE = 6;  // bound latency + clutter on import hunks with many symbols

async function goToDef(t: ExternalTarget) {
  if (!t.uri) return;
  const doc = await vscode.workspace.openTextDocument(t.uri);
  const ed = await vscode.window.showTextDocument(doc);
  const r = new vscode.Range(t.line ?? 0, 0, t.line ?? 0, 0);
  ed.revealRange(r, vscode.TextEditorRevealType.InCenter);
  ed.selection = new vscode.Selection(r.start, r.start);
}

// --- the seam tree: clusters → seams → hunks → resolved external targets ---------
type SeamTier = "spine" | "supporting" | "off";
type Node =
  | { kind: "cluster"; cluster: Cluster }
  | { kind: "subgroup"; cluster: Cluster; group: SubGroup }
  // INTENT MAP: seams grouped by relevance to the question — the spine (main path) leads, supporting
  // and off-intent side-effects collapse below it. Only built when the engine tiered the seams.
  | { kind: "tierGroup"; cluster: Cluster; tier: SeamTier; seams: Seam[] }
  // POLICY shape (cross-cutting concern): the MECHANISM (backward slice — how it works) + a collapsed
  // ENFORCEMENT surface (forward slice — the N sites it's applied at, grouped by directory).
  | { kind: "policyGroup"; cluster: Cluster; side: "mechanism" | "enforcement" }
  | { kind: "enforcementDir"; dir: string; hunks: SeamHunk[] }
  | { kind: "seam"; cluster: Cluster; seam: Seam }
  // Diff-review IMPACT (--review-impact): a ⚡ group under a seam, expanding to the cross-stack/transitive
  // consumers the change touches in untouched files, graded by the relevance floor.
  | { kind: "impactGroup"; seam: Seam }
  | { kind: "impactEdge"; rel: Relevance; relation: string; label: string; file: string; provenance?: string; reason?: string }
  // The .seam learned-adapter flywheel — a top-level reviewable record of the framework-key adapters this
  // run used (replayed) / newly learned, with a promote hint.
  | { kind: "adapters" }
  | { kind: "adapterRow"; name: string; scope: string; isNew: boolean }
  | { kind: "hunk"; cluster: Cluster; seam: Seam; hunk: SeamHunk }
  | { kind: "extTarget"; target: ExternalTarget }
  // codebase-mode blind-spot map (the differentiator): the statically-opaque mechanisms
  // and the UNKNOWN queries, surfaced separately from the resolved seams (plan §1/§6).
  | { kind: "shadows" }
  | { kind: "blindspot"; bs: BlindSpot }
  | { kind: "candidate"; cand: SuggestedCandidate }
  | { kind: "unknown"; ur: Unresolved }
  // Model B: a proposed behavioural sub-core under a core hunk.
  | { kind: "subcore"; hunk: SeamHunk; sub: SubCore }
  // Model A: a contract member (prop/param) under a core hunk, and (A2) its feeders.
  | { kind: "contract"; hunk: SeamHunk; member: ContractMember }
  | { kind: "feed"; feed: ContractFeed; prop: string }
  // Blast radius (diff mode): a consumer OUTSIDE the diff of a symbol this hunk defines.
  | { kind: "consumer"; hunk: SeamHunk; consumer: Consumer }
  | { kind: "feedDef"; uri: vscode.Uri; line: number; value: string }   // A3: where a fed value is defined
  // S1: a resolved seam-to-seam wiring under a seam (the seam graph).
  | { kind: "seamLink"; toId: string; provenance: string }
  // Chain view: one directed edge off a symbol — outgoing dep (→), incoming use (←), or a SUGGESTED
  // crossing (⧉). Carries the relation kind + provenance so the nature is visible.
  | { kind: "edge"; dir: "out" | "in" | "suggested"; toId?: string; targetLabel?: string; edgeKind: string; provenance: string }
  // The inter-seam CONTRACT, marked ON a participating hunk: the SINGLE counterpart on the other side
  // (the core a link reaches → outgoing; the link that reaches a core ← ingoing) — no duplicated pair.
  | { kind: "contractCross"; link: GraphEdge; selfId: string };

// A3: lazy cache of "where does this fed value come from" (one more hop up the chain).
const feedDefCache = new Map<string, Promise<{ uri: vscode.Uri; line: number }[]>>();

// Find a rendered hunk by node id (for navigating to a blind spot's location).
function findHunkById(id: string): SeamHunk | undefined {
  if (!model) return undefined;
  for (const cl of model.clusters) for (const s of cl.seams) for (const h of s.hunks) if (h.id === id) return h;
  return model.tests.find((h) => h.id === id);
}
// The inter-seam contract, viewed FROM a hunk: the bridging links this hunk is an endpoint of (within
// the contracts the given seam participates in), plus the partner seams on the other side. Drives the
// inline "↔ <other seam>" marker on the code block itself, instead of a detached contract section.
function hunkContract(seamId: string, hunkId: string): { links: GraphEdge[]; partners: Set<string> } {
  const links: GraphEdge[] = [];
  const partners = new Set<string>();
  for (const [partnerId, contract] of seamContractsByPartner.get(seamId) ?? [])
    for (const link of contract.links)
      if (link.from === hunkId || link.to === hunkId) { links.push(link); partners.add(partnerId); }
  return { links, partners };
}
const hasShadows = (m: SeamModel): boolean =>
  m.mode === "codebase" && !!((m.blindspots?.length ?? 0) + (m.unresolved?.length ?? 0));
const hasAdapters = (m: SeamModel): boolean =>
  !!((m.adapters?.used?.length ?? 0) + (m.adapters?.learned?.length ?? 0));

const ROLE_ICON: Record<string, string> = {
  core: "symbol-method", link: "link", environment: "symbol-field",
  test: "beaker", noise: "circle-slash",
};
// The seam panel reads like a MAP: each seam shows its HEALTH (what needs validating) and its
// role MAKEUP (its character at a glance), and the riskiest seams float to the top. Monochrome
// glyphs for the inline description (no per-char colour in a tree); colour lives on the icon
// and in the Markdown tooltip's emoji micro-bar.
const ROLE_MK: Record<string, string> = { core: "◆", link: "⇄", environment: "▦", test: "✓", noise: "·" };
const ROLE_SQUARE: Record<string, string> = { core: "🟧", link: "🟦", environment: "⬜", test: "🟩" };

interface SeamHealth { rank: number; glyph: string; tag: string; colorId?: string; }
// One posture per seam, highest-priority-wins, ranked so sortedSeams surfaces "go verify this"
// first. Mirrors the engine's warning kinds + the role-vote/crossing flags.
function seamHealth(s: Seam): SeamHealth {
  const w = new Set(s.warnings ?? []);
  if (s.suggested) return { rank: 4, glyph: "↝", tag: "suggested seam — reached only across a heuristic crossing; verify it", colorId: "charts.orange" };
  if (w.has("isolated-core")) return { rank: 3, glyph: "⚠", tag: "isolated core — no link in this seam; verify the consumer (elsewhere or outside the diff)", colorId: "charts.yellow" };
  if (s.uncertain) return { rank: 2, glyph: "?", tag: "uncertain — the role vote was split; treat the roles as a maybe", colorId: "charts.yellow" };
  if (w.has("dangling-link")) return { rank: 2, glyph: "⤳", tag: "dangling link — no core here; wires to something changed elsewhere", colorId: "charts.blue" };
  if (s.linkOnly || w.has("delegated")) return { rank: 1, glyph: "◦", tag: "link-only / ambient — trust delegated to the consumer" };
  return { rank: 0, glyph: "", tag: "" };
}
// Stable risk-first order (engine order breaks ties) — used for BOTH the tree and the
// auto-focus pick so the focused seam == the top of the panel.
function sortedSeams(seams: Seam[]): Seam[] {
  return seams.map((s, i) => [s, i] as const)
    .sort((a, b) => (seamHealth(b[0]).rank - seamHealth(a[0]).rank) || (a[1] - b[1]))
    .map(([s]) => s);
}
// Does a seam's review impact have anything worth showing? (irrelevant edges are suppressed by the
// floor — they never render; gaps and any relevant/unknown edge do.)
function shownImpact(im?: SeamImpact): boolean {
  if (!im) return false;
  return im.crossStack.some((c) => c.relevance !== "irrelevant")
    || im.external.some((e) => e.relevance !== "irrelevant")
    || im.gaps.length > 0;
}
// The headline counts for a seam's impact group label (relevant cross-stack drives the ⚠).
function impactCounts(im: SeamImpact): { relevant: number; unknown: number } {
  const all = [...im.crossStack, ...im.external];
  return { relevant: all.filter((e) => e.relevance === "relevant").length,
           unknown: all.filter((e) => e.relevance === "unknown").length + im.gaps.length };
}
function seamRoleCounts(s: Seam): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of s.hunks) {
    const r = ROLES.includes(h.role) ? h.role : "noise";
    m.set(r, (m.get(r) ?? 0) + 1);
  }
  return m;
}
// Compact "2◆ 3⇄ 1▦" for the tree description — noise omitted so it recedes (unless that's all).
function makeupText(counts: Map<string, number>): string {
  const signal = ROLES.filter((r) => r !== "noise" && counts.get(r));
  const roles = signal.length ? signal : ROLES.filter((r) => counts.get(r));
  return roles.map((r) => `${counts.get(r)}${ROLE_MK[r] ?? "·"}`).join(" ");
}
// A proportional colour bar (≤ ~12 cells) for the tooltip — the one place a tree can show colour.
function makeupBar(counts: Map<string, number>): string {
  const signal = ROLES.filter((r) => r !== "noise");
  const total = signal.reduce((a, r) => a + (counts.get(r) ?? 0), 0);
  if (!total) return "";
  return signal.map((r) => (ROLE_SQUARE[r] ?? "").repeat(Math.round(((counts.get(r) ?? 0) / total) * 12))).join("");
}

class SeamTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  refresh() { this._onDidChange.fire(); }

  getChildren(el?: Node): Node[] | Promise<Node[]> {
    if (!model) return [];
    if (!el) {
      const roots: Node[] = model.clusters.map((cluster) => ({ kind: "cluster", cluster }));
      // The inter-seam CONTRACT is no longer a dedicated section — each contract drills down INLINE
      // under the connection rows of the two seams it bridges (see the "seam"/"seamLink" branches).
      // The blind-spot map sits at the TOP LEVEL, beside the seams, so "where I'm blind"
      // is as visible as "what I resolved" (the differentiator — never buried).
      if (hasShadows(model)) roots.push({ kind: "shadows" });
      if (hasAdapters(model)) roots.push({ kind: "adapters" });   // the .seam flywheel, reviewable
      return roots;
    }
    if (el.kind === "adapters") {
      const a = model.adapters!;
      const rows: Node[] = (a.learned ?? []).map((name) => ({ kind: "adapterRow", name, scope: "repo", isNew: true } as Node));
      const learnedSet = new Set(a.learned ?? []);
      for (const u of a.used ?? []) if (!learnedSet.has(u.name)) rows.push({ kind: "adapterRow", name: u.name, scope: u.scope, isNew: false } as Node);
      return rows;
    }
    if (el.kind === "shadows") {
      const out: Node[] = (model.blindspots ?? []).map((bs) => ({ kind: "blindspot", bs } as Node));
      return out.concat((model.unresolved ?? []).map((ur) => ({ kind: "unknown", ur } as Node)));
    }
    if (el.kind === "blindspot")
      return el.bs.candidates.map((cand) => ({ kind: "candidate", cand } as Node));
    if (el.kind === "contract")
      return (el.member.feeds ?? []).map((feed) => ({ kind: "feed", feed, prop: el.member.name } as Node));
    if (el.kind === "feed") {
      const f = el.feed;
      if (f.valLine === undefined || f.valCol === undefined) return [];
      const uri = vscode.Uri.file(path.join(repoRoot, f.from));
      const key = `${uri.fsPath}#${f.valLine}:${f.valCol}`;
      let p = feedDefCache.get(key);
      if (!p) {
        p = (async () => {
          try {
            const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
              "vscode.executeDefinitionProvider", uri, new vscode.Position(f.valLine!, f.valCol!));
            return (defs ?? []).map((d) => "targetUri" in d
              ? { uri: d.targetUri, line: d.targetRange.start.line }
              : { uri: d.uri, line: d.range.start.line });
          } catch { return []; }
        })();
        feedDefCache.set(key, p);
      }
      return p.then((defs) => defs.slice(0, 1).map((d) =>
        ({ kind: "feedDef", uri: d.uri, line: d.line, value: f.value } as Node)));
    }
    if (el.kind === "cluster") {
      // P2 #2: when a seam is focused, ISOLATE it — show only that seam (others discarded). Guarded:
      // if the focused id isn't in this model (e.g. it changed after an expand), fall back to all.
      const isolate = focusedSeamId && el.cluster.seams.some((s) => s.id === focusedSeamId);
      if (isolate)
        return el.cluster.seams.filter((s) => s.id === focusedSeamId)
          .map((seam) => ({ kind: "seam", cluster: el.cluster, seam }));
      // POLICY shape: a cross-cutting concern has no spine — render the MECHANISM (how it works) and a
      // collapsed ENFORCEMENT surface (where it's applied), not a flat fan of N equal seams.
      if (model.shape === "policy")
        return [{ kind: "policyGroup", cluster: el.cluster, side: "mechanism" } as Node,
                { kind: "policyGroup", cluster: el.cluster, side: "enforcement" } as Node];
      // INTENT MAP (codebase): when the engine tiered the seams, group them by relevance — Main path
      // (the spine, in trace order) leads; Supporting and Off-intent collapse below. Preserves engine
      // order WITHIN a tier (the spine is BFS-traced anchor→display), so the path reads top-to-bottom.
      if (el.cluster.seams.some((s) => s.tier)) {
        const tiers: SeamTier[] = ["spine", "supporting", "off"];
        return tiers
          .map((tier) => ({ tier, seams: el.cluster.seams.filter((s) => (s.tier ?? "supporting") === tier) }))
          .filter((grp) => grp.seams.length)
          .map((grp) => ({ kind: "tierGroup", cluster: el.cluster, tier: grp.tier, seams: grp.seams } as Node));
      }
      // Altitude: a big cluster shows its SUB-GROUPS (collapsed by default = overview); expand one
      // to drill into its seams. Small/tight clusters have no subgroups → seams directly.
      if (el.cluster.subgroups?.length)
        return el.cluster.subgroups.map((group) => ({ kind: "subgroup", cluster: el.cluster, group }));
      return sortedSeams(el.cluster.seams).map((seam) => ({ kind: "seam", cluster: el.cluster, seam }));
    }
    if (el.kind === "subgroup") {
      const ids = new Set(el.group.seamIds);
      return sortedSeams(el.cluster.seams.filter((s) => ids.has(s.id)))
        .map((seam) => ({ kind: "seam", cluster: el.cluster, seam }));
    }
    if (el.kind === "tierGroup")
      // Keep ENGINE order (spine = BFS trace anchor→display; others = discovery order) — do NOT risk-sort,
      // or the path stops reading as a path. The per-seam health glyph still carries the risk signal.
      return el.seams.map((seam) => ({ kind: "seam", cluster: el.cluster, seam }));
    if (el.kind === "policyGroup") {
      const hunks = el.cluster.seams.flatMap((s) => s.hunks);
      if (el.side === "mechanism")
        // the backward slice (+ the anchor itself) — the few deps that ARE the answer to "how does it work"
        return hunks.filter((h) => h.direction === "backward" || h.id === "n1")
          .map((hunk) => ({ kind: "hunk", cluster: el.cluster, seam: el.cluster.seams[0], hunk }));
      // the forward slice, collapsed to a counted surface grouped by directory (an enforcement map, not N seams)
      const byDir = new Map<string, SeamHunk[]>();
      for (const h of hunks.filter((h) => h.direction === "forward")) {
        const dir = h.file.split("/").slice(0, -1).join("/") || h.file;
        (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(h);
      }
      return [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)
        .map(([dir, hs]) => ({ kind: "enforcementDir", dir, hunks: hs } as Node));
    }
    if (el.kind === "enforcementDir")
      return el.hunks.map((hunk) => ({ kind: "hunk", cluster: model!.clusters[0], seam: model!.clusters[0].seams[0], hunk }));
    if (el.kind === "seam") {
      // the seam's resolved wiring (other seams it connects to) shows first, then its hunks. The
      // inter-seam CONTRACT is not a row here — it's marked on the participating hunks themselves.
      const links: Node[] = (seamNeighbors.get(el.seam.id) ?? [])
        .map((n) => ({ kind: "seamLink", toId: n.id, provenance: n.provenance } as Node));
      // Review impact: a ⚡ group leads (above wiring/hunks) when the change touches anything beyond the PR.
      const impact: Node[] = shownImpact(el.seam.impact) ? [{ kind: "impactGroup", seam: el.seam }] : [];
      const hunks: Node[] = el.seam.hunks.map((hunk) => ({ kind: "hunk", cluster: el.cluster, seam: el.seam, hunk }));
      return [...impact, ...links, ...hunks];
    }
    if (el.kind === "impactGroup") {
      const im = el.seam.impact!;
      const rank: Record<Relevance, number> = { relevant: 0, unknown: 1, irrelevant: 2 };
      // cross-stack rows (relevant first), then transitive-consumer rows; irrelevant ones never reach here.
      const cross: Node[] = im.crossStack.filter((c) => c.relevance !== "irrelevant")
        .sort((a, b) => rank[a.relevance] - rank[b.relevance])
        .map((c) => ({ kind: "impactEdge", rel: c.relevance, relation: `${c.relation} of '${c.key}'`,
          label: c.symbol, file: c.file, provenance: c.provenance, reason: c.triageReason } as Node));
      const ext: Node[] = im.external.filter((e) => e.relevance !== "irrelevant")
        .sort((a, b) => rank[a.relevance] - rank[b.relevance])
        .map((e) => ({ kind: "impactEdge", rel: e.relevance, relation: e.hop > 1 ? `consumer (hop ${e.hop})` : "consumer",
          label: e.symbol, file: e.file } as Node));
      const gaps: Node[] = im.gaps.length
        ? [{ kind: "impactEdge", rel: "unknown", relation: "opaque caller(s) — impact may be larger",
            label: `${im.gaps.length} gap${im.gaps.length !== 1 ? "s" : ""}`, file: "" } as Node]
        : [];
      return [...cross, ...ext, ...gaps];
    }
    if (el.kind === "hunk") {
      if (chainView) {
        // Chain view: this symbol's directed edges — what it depends on (→), what uses it (←), and
        // any SUGGESTED crossing (⧉) — each with its relation kind + provenance.
        const id = el.hunk.id;
        const out = (model.edges ?? []).filter((e) => e.from === id)
          .map((e) => ({ kind: "edge", dir: "out", toId: e.to, edgeKind: e.kind, provenance: e.provenance } as Node));
        const inc = (model.edges ?? []).filter((e) => e.to === id)
          .map((e) => ({ kind: "edge", dir: "in", toId: e.from, edgeKind: e.kind, provenance: e.provenance } as Node));
        const sug = (model.blindspots ?? [])
          .filter((b) => b.node === el.hunk.label || b.node === id)
          .flatMap((b) => b.candidates.map((c) =>
            ({ kind: "edge", dir: "suggested", targetLabel: c.symbol, edgeKind: b.mechanism, provenance: c.provenance } as Node)));
        return [...out, ...inc, ...sug];
      }
      // A core expands to its drill-downs: the CONTRACT members (Model A) and any proposed
      // behavioural sub-cores (Model B) — both are finer altitudes of the one core.
      const drill: Node[] = [];
      // Inter-seam contract: the COUNTERPART this hunk reaches (or is reached by) shows FIRST — the
      // boundary lives on the code block, and each row points only at its other end (no pair dup).
      for (const link of hunkContract(el.seam.id, el.hunk.id).links)
        drill.push({ kind: "contractCross", link, selfId: el.hunk.id });
      for (const member of el.hunk.contract ?? []) drill.push({ kind: "contract", hunk: el.hunk, member });
      for (const sub of el.hunk.subcores ?? []) drill.push({ kind: "subcore", hunk: el.hunk, sub });
      // Blast radius: who outside the diff consumes a symbol this hunk defines (resolved first).
      const cons = [...(el.hunk.consumers ?? [])].sort((a, b) =>
        (a.status === "resolved" ? 0 : 1) - (b.status === "resolved" ? 0 : 1));
      for (const consumer of cons) drill.push({ kind: "consumer", hunk: el.hunk, consumer });
      if (drill.length) return drill;
      // Lazy Layer 2: resolve the hunk's external couplings only when it's expanded.
      const refs = el.hunk.externalRefs ?? [];
      if (!refs.length) return [];
      let p = resolveCache.get(el.hunk.id);
      if (!p) {
        const hunk = el.hunk;
        p = Promise.all(refs.slice(0, MAX_RESOLVE).map((r) => resolver.resolve(r, hunk)));
        resolveCache.set(hunk.id, p);
      }
      return p.then((targets) => targets.map((target) => ({ kind: "extTarget", target } as Node)));
    }
    return [];
  }

  getTreeItem(el: Node): vscode.TreeItem {
    if (el.kind === "cluster") {
      const it = new vscode.TreeItem(el.cluster.intent, vscode.TreeItemCollapsibleState.Expanded);
      const nsub = el.cluster.subgroups?.length ?? 0;
      const count = nsub ? `${nsub} groups · ${el.cluster.seams.length} seams` : `${el.cluster.seams.length} seams`;
      // Progressive reveal: while the LLM enrichment runs over the skeleton, the cluster header carries a
      // spinner + note so the deterministic result reads as "live, being named", not final.
      it.iconPath = new vscode.ThemeIcon(enriching ? "loading~spin" : "symbol-color");
      it.description = enriching ? `${count} · ⟳ naming & ranking…` : count;
      it.tooltip = enriching
        ? "The deterministic skeleton is shown; the LLM is naming the seams and sorting them into "
          + "Main path / Supporting / Side-effects. The list updates in place when it finishes."
        : undefined;
      return it;
    }
    if (el.kind === "policyGroup") {
      const hunks = el.cluster.seams.flatMap((s) => s.hunks);
      if (el.side === "mechanism") {
        const n = hunks.filter((h) => h.direction === "backward").length;
        const lead = model?.lead !== "forward";   // mechanism leads unless the question is about "where used"
        const it = new vscode.TreeItem("◆ Mechanism",
          lead ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        it.description = `how it works · ${n} dep${n !== 1 ? "s" : ""}`;
        it.iconPath = new vscode.ThemeIcon("gear");
        it.tooltip = "The backward slice — the dependencies this cross-cutting concern is built on (the actual answer to \"how does it work\"). Often delegates outward; check the blind spots for external deps.";
        return it;
      }
      const files = new Set(hunks.filter((h) => h.direction === "forward").map((h) => h.file)).size;
      const it = new vscode.TreeItem("· Enforced at",
        model?.lead === "forward" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${files} site${files !== 1 ? "s" : ""}`;
      it.iconPath = new vscode.ThemeIcon("shield", new vscode.ThemeColor("descriptionForeground"));
      it.tooltip = "The forward slice — the sites where this concern is applied, collapsed by directory. A surface to scan, not a flow: there's no spine because it's a policy enforced at N points.";
      return it;
    }
    if (el.kind === "enforcementDir") {
      const it = new vscode.TreeItem(`${el.dir}/`, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${el.hunks.length} site${el.hunks.length !== 1 ? "s" : ""}`;
      it.iconPath = new vscode.ThemeIcon("folder");
      return it;
    }
    if (el.kind === "tierGroup") {
      const meta = {
        spine: { glyph: "◆", label: "Main path", icon: "target", expand: true, tip: "The spine that answers the question — the flow from the anchor through processing to what's displayed, in trace order." },
        supporting: { glyph: "▸", label: "Supporting", icon: "list-tree", expand: false, tip: "Needed or related, but not the main flow (auth, config, helpers, secondary lookups)." },
        off: { glyph: "·", label: "Side-effects & off-intent", icon: "circle-outline", expand: false, tip: "Connected, but a different concern — a sibling entity's CRUD, a side-effect, logging, a utility." },
      }[el.tier];
      const it = new vscode.TreeItem(`${meta.glyph} ${meta.label}`,
        meta.expand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${el.seams.length} seam${el.seams.length !== 1 ? "s" : ""}`;
      it.iconPath = new vscode.ThemeIcon(meta.icon, el.tier === "off" ? new vscode.ThemeColor("disabledForeground") : undefined);
      it.tooltip = meta.tip;
      it.contextValue = "seam.tierGroup";
      return it;
    }
    if (el.kind === "subgroup") {
      // ALTITUDE control: collapsed = overview (you see the few groups), expand = zoom into its seams.
      // The default depth is a setting so a reviewer can start at "overview" or "seams".
      const detail = (vscode.workspace.getConfiguration("seam").get<string>("defaultAltitude") || "overview") === "seams";
      const it = new vscode.TreeItem(`▸ ${el.group.label}`,
        detail ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      const n = el.group.seamIds.length;
      it.description = `${n} seam${n !== 1 ? "s" : ""}`;
      it.iconPath = new vscode.ThemeIcon("list-tree");
      it.tooltip = "Sub-group — a structural grouping of this cluster's seams (by coupling & directory), "
        + "not a claimed intent. Collapse for an overview; expand to review its seams.";
      it.contextValue = "seam.subgroup";
      return it;
    }
    if (el.kind === "impactGroup") {
      const ic = impactCounts(el.seam.impact!);
      const it = new vscode.TreeItem("⚡ Impact (beyond this PR)",
        ic.relevant ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = [ic.relevant ? `${ic.relevant} to verify` : "", ic.unknown ? `${ic.unknown} maybe` : ""]
        .filter(Boolean).join(" · ") || "blast radius";
      it.iconPath = new vscode.ThemeIcon("zap", ic.relevant ? new vscode.ThemeColor("charts.yellow") : undefined);
      it.tooltip = "What this change touches BEYOND its own lines — transitive consumers and cross-stack "
        + "data-flow readers/writers in files this PR did NOT change. Graded by the deterministic relevance "
        + "floor: shown = couldn't be ruled out (verify); provably-unrelated edges are suppressed. Information to verify, not asserted bugs.";
      it.contextValue = "seam.impactGroup";
      return it;
    }
    if (el.kind === "impactEdge") {
      const it = new vscode.TreeItem(`${el.rel === "relevant" ? "⚠ " : ""}${el.relation} → ${el.label}`,
        vscode.TreeItemCollapsibleState.None);
      it.description = [el.file ? el.file.split("/").pop() : "",
        el.provenance && el.provenance !== "RESOLVED_FULL" ? `[${el.provenance}]` : "",
        el.rel === "unknown" ? "verify" : ""].filter(Boolean).join(" · ");
      it.iconPath = new vscode.ThemeIcon(
        el.rel === "relevant" ? "warning" : "question",
        new vscode.ThemeColor(el.rel === "relevant" ? "charts.yellow" : "descriptionForeground"));
      it.tooltip = (el.reason ? `${el.reason}\n\n` : "")
        + (el.file ? `${el.file}\n\n` : "")
        + (el.rel === "relevant"
            ? "The change touched a field this consumer uses — verify it still holds."
            : "Couldn't prove relevant or not — a lead to check, not an asserted break.");
      if (el.file) {
        const uri = vscode.Uri.file(path.join(repoRoot, el.file));
        it.command = { command: "vscode.open", title: "Open", arguments: [uri] };
        it.resourceUri = uri;
      }
      return it;
    }
    if (el.kind === "seam") {
      const h = seamHealth(el.seam);
      const counts = seamRoleCounts(el.seam);
      // Connections = the UNION of resolved seam-edges and shared contracts (a contract may exist
      // without a seam-edge), so the ↔ badge counts every other seam this one actually touches.
      const partnerIds = new Set<string>((seamNeighbors.get(el.seam.id) ?? []).map((n) => n.id));
      for (const pid of seamContractsByPartner.get(el.seam.id)?.keys() ?? []) partnerIds.add(pid);
      const wired = partnerIds.size;
      // Spine seams lead with their step in the main-path trace (1 = anchor … N = what's displayed).
      const step = el.cluster.spine?.indexOf(el.seam.id) ?? -1;
      const lead = step >= 0 ? `${step + 1}. ` : "";
      const it = new vscode.TreeItem(
        h.glyph ? `${lead}${h.glyph} ${el.seam.label}` : `${lead}${el.seam.label}`, vscode.TreeItemCollapsibleState.Collapsed);
      // Description = the seam's CHARACTER (role makeup) + how connected it is — risk lives in the
      // glyph + icon colour, not the text, so the line stays calm. A ⚡ badge surfaces review impact
      // (the change touches code beyond the PR); ⏳ while the impact pass is still annotating.
      const ic = shownImpact(el.seam.impact) ? impactCounts(el.seam.impact!) : null;
      const impactBadge = ic
        ? `⚡${ic.relevant ? ic.relevant : ""}${ic.relevant && ic.unknown ? "+" : ""}${!ic.relevant && ic.unknown ? `?${ic.unknown}` : ""}`
        : annotatingImpact ? "⏳" : "";
      it.description = [makeupText(counts), wired ? `↔${wired}` : "", impactBadge].filter(Boolean).join("  ·  ");
      // While enriching, a not-yet-tiered seam is one the LLM is still naming/categorising → spin it; an
      // already-tiered seam (or a finished run) keeps its normal merge icon.
      it.iconPath = enriching && !el.seam.tier
        ? new vscode.ThemeIcon("loading~spin")
        : new vscode.ThemeIcon(
            el.seam.uncertain && !el.seam.suggested ? "question" : "git-merge",
            h.colorId ? new vscode.ThemeColor(h.colorId) : undefined);
      const md = new vscode.MarkdownString(`**${el.seam.label}**\n\n`);
      if (h.tag) md.appendMarkdown(`${h.glyph} ${h.tag}\n\n`);
      const bar = makeupBar(counts);
      if (bar) md.appendMarkdown(`${bar}\n\n`);
      const parts = ROLES.filter((r) => counts.get(r)).map((r) => `${counts.get(r)} ${r}`);
      md.appendMarkdown(`${parts.join(" · ")} · ${el.seam.hunks.length} hunks${wired ? ` · ↔ ${wired} wired` : ""}`);
      it.tooltip = md;
      return it;
    }
    if (el.kind === "seamLink") {
      const it = new vscode.TreeItem(`↔ ${seamLabel.get(el.toId) ?? el.toId}`, vscode.TreeItemCollapsibleState.None);
      it.description = "wires to";
      it.iconPath = new vscode.ThemeIcon("arrow-both");
      it.tooltip = `Resolved seam-to-seam wiring → ${seamLabel.get(el.toId) ?? el.toId} (${el.provenance}). Click to focus it.`;
      it.command = { command: "seam.focusSeamById", title: "Focus wired seam", arguments: [el.toId] };
      return it;
    }
    if (el.kind === "edge") {
      // Chain view: one symbol→symbol link with its nature. → depends on, ← used by, ⧉ suggested.
      const target = el.toId ? findHunkById(el.toId) : undefined;
      const label = el.targetLabel ?? target?.label ?? el.toId ?? "?";
      const arrow = el.dir === "out" ? "→" : el.dir === "in" ? "←" : "⧉";
      const partial = /PARTIAL/.test(el.provenance), suggested = el.dir === "suggested" || /SUGGEST/i.test(el.provenance);
      const it = new vscode.TreeItem(`${arrow} ${label}`, vscode.TreeItemCollapsibleState.None);
      const provLabel = suggested ? "SUGGESTED" : partial ? "RESOLVED (partial)" : "RESOLVED";
      it.description = `${el.edgeKind} · ${provLabel}`;
      it.iconPath = new vscode.ThemeIcon(
        suggested ? "lightbulb" : el.dir === "in" ? "arrow-small-left" : "arrow-small-right",
        new vscode.ThemeColor(suggested ? "charts.yellow" : partial ? "charts.orange" : "charts.green"));
      const verb = el.dir === "in" ? "used by" : el.dir === "suggested" ? "assumed to reach" : "depends on";
      it.tooltip = `${verb} ${label}\nrelation: ${el.edgeKind} · ${provLabel}` +
        (suggested ? "\n(an assumption — never counted as resolved)" :
         partial ? "\n(heuristic match — a strong but unverified signal)" : "");
      if (target) it.command = { command: "seam.open", title: "Open", arguments: [target] };
      return it;
    }
    if (el.kind === "contractCross") {
      // The hunk's single counterpart across the seam boundary. If THIS hunk is the source (→ out),
      // we point at the callee's definition; if it's the target (← in), at the exact call-site.
      const l = el.link;
      const out = l.from === el.selfId;
      const partner = findHunkById(out ? l.to : l.from);
      const partial = /PARTIAL/.test(l.provenance), suggested = /SUGGEST/i.test(l.provenance);
      const provLabel = suggested ? "SUGGESTED" : partial ? "RESOLVED (partial)" : "RESOLVED";
      // outgoing → the counterpart's definition line; ingoing → the call-site line (l.line).
      const line = out ? (partner?.start ?? 0) : (l.line && l.line > 0 ? l.line : (partner?.start ?? 0));
      const it = new vscode.TreeItem(`${out ? "→" : "←"} ${partner?.label ?? (out ? l.to : l.from)}`,
        vscode.TreeItemCollapsibleState.None);
      it.description = `${partner ? partner.file.split("/").pop() + ":" + line : ""} · ${l.kind} · ${provLabel}`;
      it.iconPath = new vscode.ThemeIcon(out ? "arrow-small-right" : "arrow-small-left",
        new vscode.ThemeColor(suggested ? "charts.yellow" : partial ? "charts.orange" : "charts.green"));
      it.tooltip = out
        ? `reaches ${partner?.label ?? l.to} (${partner?.file}:${line}) — the seam boundary this block crosses TO`
        : `reached from ${partner?.label ?? l.from} (${partner?.file}:${line}) — where the other seam crosses INTO this block`;
      if (partner) it.command = { command: "seam.open", title: "Open", arguments: [{ ...partner, start: line, end: line }] };
      return it;
    }
    if (el.kind === "adapters") {
      const nNew = model?.adapters?.learned?.length ?? 0;
      const nUsed = model?.adapters?.used?.length ?? 0;
      const it = new vscode.TreeItem("Learned adapters (.seam)",
        nNew ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = [nNew ? `+${nNew} new` : "", nUsed ? `${nUsed} replayed` : ""].filter(Boolean).join(" · ");
      it.iconPath = new vscode.ThemeIcon("plug", nNew ? new vscode.ThemeColor("charts.green") : undefined);
      it.tooltip = "Framework-key coupling adapters Seam LEARNED for unknown/homemade frameworks "
        + "(LLM-once → deterministic-forever, stored in .seam/). 'new' = deduced this run; 'replayed' = "
        + "applied offline from .seam/. Review & share with `seam-adapters list | promote <name>`.";
      it.contextValue = "seam.adapters";
      return it;
    }
    if (el.kind === "adapterRow") {
      const it = new vscode.TreeItem(`${el.isNew ? "✦ " : ""}${el.name}`, vscode.TreeItemCollapsibleState.None);
      it.description = el.isNew ? "new this run" : `replayed · ${el.scope}`;
      it.iconPath = new vscode.ThemeIcon(el.isNew ? "sparkle" : "plug",
        el.isNew ? new vscode.ThemeColor("charts.green") : undefined);
      it.tooltip = el.isNew
        ? `Learned this run (LLM-deduced, persisted to .seam/). Promote to share: seam-adapters promote ${el.name}`
        : `Replayed offline from the ${el.scope} .seam store (deterministic, no LLM).`;
      return it;
    }
    if (el.kind === "shadows") {
      const nb = model?.blindspots?.length ?? 0, nu = model?.unresolved?.length ?? 0;
      const it = new vscode.TreeItem("Blind spots & unknowns", vscode.TreeItemCollapsibleState.Expanded);
      it.description = [nb ? `${nb} opaque` : "", nu ? `${nu} unknown` : ""].filter(Boolean).join(" · ");
      it.iconPath = new vscode.ThemeIcon("eye-closed");
      it.tooltip = "Where this view is, by construction, blind: statically-opaque wiring " +
        "(DI/reflection/events) and queries the resolver could not answer. UNKNOWN ≠ no link.";
      return it;
    }
    if (el.kind === "blindspot") {
      const b = el.bs;
      const it = new vscode.TreeItem(`${b.mechanism} @ ${b.node}`,
        b.candidates.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      it.description = b.evidence;
      it.iconPath = new vscode.ThemeIcon("warning");
      it.tooltip = `Statically-opaque ${b.mechanism}: ${b.evidence}\n` +
        "The resolver sees the mechanism but not where it routes — candidates below are SUGGESTED, not resolved.";
      const h = findHunkById(b.node);
      if (h) it.command = { command: "seam.open", title: "Open", arguments: [h] };
      return it;
    }
    if (el.kind === "candidate") {
      const it = new vscode.TreeItem(`↳ ${el.cand.symbol}`, vscode.TreeItemCollapsibleState.None);
      it.description = "SUGGESTED — unverified";
      it.iconPath = new vscode.ThemeIcon("lightbulb");
      it.tooltip = `${el.cand.symbol} is a GUESSED target (${el.cand.provenance}). It is NEVER counted ` +
        "as a resolved link — the completeness promise holds only on the resolved graph.";
      return it;
    }
    if (el.kind === "unknown") {
      const u = el.ur;
      const it = new vscode.TreeItem(`? ${u.node || u.query}`, vscode.TreeItemCollapsibleState.None);
      it.description = `${u.query}: ${u.reason}`;
      it.iconPath = new vscode.ThemeIcon("question");
      it.tooltip = `The resolver could not answer ${u.query} here (${u.reason}). This is UNKNOWN — ` +
        "explicitly NOT 'no link' (which would fake an isolated-core).";
      const h = findHunkById(u.node);
      if (h) it.command = { command: "seam.open", title: "Open", arguments: [h] };
      return it;
    }
    if (el.kind === "feed") {
      const f = el.feed;
      const it = new vscode.TreeItem(`← ${f.value}`,
        f.valLine !== undefined ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      it.description = `${f.from.split("/").pop()}:${f.line + 1}`;
      it.iconPath = new vscode.ThemeIcon("arrow-small-left");
      it.tooltip = `${f.from}:${f.line + 1} feeds \`${f.value}\` to prop \`${el.prop}\`` +
        (f.valLine !== undefined ? "\nExpand to resolve where this value is defined." : "");
      it.command = { command: "seam.openFeed", title: "Reveal feeder", arguments: [f] };
      return it;
    }
    if (el.kind === "feedDef") {
      const it = new vscode.TreeItem(`→ ${el.value}`, vscode.TreeItemCollapsibleState.None);
      it.description = `defined: ${path.basename(el.uri.fsPath)}:${el.line + 1}`;
      it.iconPath = new vscode.ThemeIcon("symbol-reference");
      it.tooltip = `\`${el.value}\` is defined at ${el.uri.fsPath}:${el.line + 1}`;
      it.command = { command: "seam.openLocation", title: "Go to definition", arguments: [el.uri, el.line] };
      return it;
    }
    if (el.kind === "contract") {
      const m = el.member;
      const lines = m.ranges.map(([a, b]) => a === b ? `${a + 1}` : `${a + 1}-${b + 1}`).join(", ");
      const nf = m.feeds?.length ?? 0;
      const it = new vscode.TreeItem(m.name,
        nf ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      it.description = `${m.invoked ? "link" : "data"} · used ${lines}${nf ? ` · ${nf} feeder${nf > 1 ? "s" : ""}` : ""}`;
      it.iconPath = new vscode.ThemeIcon(m.role === "link" ? "link" : "symbol-field",
        new vscode.ThemeColor(m.role === "link" ? "charts.blue" : "charts.foreground"));
      it.tooltip = m.invoked
        ? `Contract LINK: \`${m.name}\` is a callback this anchor INVOKES — behaviour threaded in across the boundary.`
        : `Contract data: \`${m.name}\` is read-only (passive prop) — environment.`;
      it.command = { command: "seam.openContract", title: "Reveal contract use", arguments: [el.hunk, m] };
      return it;
    }
    if (el.kind === "subcore") {
      const s = el.sub;
      const lines = s.ranges.map(([a, b]) => a === b ? `${a + 1}` : `${a + 1}-${b + 1}`).join(", ");
      const it = new vscode.TreeItem(s.label, vscode.TreeItemCollapsibleState.None);
      it.description = `proposed · ${lines}`;
      it.iconPath = new vscode.ThemeIcon("lightbulb");   // distinct from role icons — a suggestion
      it.tooltip = `PROPOSED behaviour grouping (not a verified boundary): ${s.reads.join(", ")}\n` +
        "The lines are real; the grouping is a suggested reading of them — it can't fabricate a coupling.";
      it.command = { command: "seam.openSubcore", title: "Reveal proposed sub-core", arguments: [el.hunk, s] };
      return it;
    }
    if (el.kind === "consumer") {
      // Blast radius: a file outside the diff that imports a symbol this hunk defines. Resolved =
      // confirmed consumer (green); suggested = unresolvable basename match, a blind spot (yellow).
      const c = el.consumer;
      const resolved = c.status === "resolved";
      const it = new vscode.TreeItem(`⇲ ${path.basename(c.file)}`, vscode.TreeItemCollapsibleState.None);
      it.description = `${resolved ? "uses" : "may use"} ${c.symbol}`;
      it.tooltip = `${c.file}\n${resolved ? "RESOLVED consumer" : "SUGGESTED (unresolvable import; basename matches — verify)"}`
        + `: imports ${c.symbol} (defined in this change).`;
      it.iconPath = new vscode.ThemeIcon(resolved ? "references" : "question",
        new vscode.ThemeColor(resolved ? "charts.green" : "charts.yellow"));
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/"), c.file);
      it.command = { command: "vscode.open", title: "Open consumer", arguments: [uri] };
      return it;
    }
    if (el.kind === "extTarget") {
      const t = el.target;
      const it = new vscode.TreeItem(`↳ ${t.symbol}`, vscode.TreeItemCollapsibleState.None);
      it.description = t.uri ? `${path.basename(t.uri.fsPath)}:${(t.line ?? 0) + 1}`
                             : `${t.source} (not found)`;
      it.tooltip = (t.detail ? t.detail + "\n" : "") + `${t.symbol} — ${t.source}` +
        (t.uri ? `\n${t.uri.fsPath}:${(t.line ?? 0) + 1}` : "\n(definition not in workspace — likely node_modules)");
      it.iconPath = new vscode.ThemeIcon(t.uri ? "symbol-reference" : "question");
      if (t.uri) it.command = { command: "seam.goToDef", title: "Go to definition", arguments: [t] };
      return it;
    }
    const h = el.hunk;
    // Inter-seam contract, marked ON the code block: which seam(s) on the other side, and the
    // DIRECTION — → this block reaches OUT to a counterpart, ← it's reached INTO, ↔ both. The role
    // icon is tinted by the contract's solidity so the boundary block "pops" in the seam.
    const ct = hunkContract(el.seam.id, h.id);
    const ctPartners = [...ct.partners].map((id) => seamLabel.get(id) ?? id);
    const ctOut = ct.links.some((l) => l.from === h.id), ctIn = ct.links.some((l) => l.to === h.id);
    const ctArrow = ctOut && ctIn ? "↔" : ctOut ? "→" : "←";
    const ctTag = ct.links.length
      ? `${ctArrow} ${ctPartners.length === 1 ? ctPartners[0] : ctPartners.length + " seams"}` : "";
    const ctColor = !ct.links.length ? ""
      : ct.links.some((l) => /SUGGEST/i.test(l.provenance)) ? "charts.yellow"
      : ct.links.some((l) => /PARTIAL/.test(l.provenance)) ? "charts.orange" : "charts.green";
    const unc = isUncertain(h);
    const ext = extTag(h);
    const rw = rewireStr(h);
    const ncon = h.contract?.length ?? 0, nsub = h.subcores?.length ?? 0;
    const ncons = h.consumers?.length ?? 0;   // blast radius: consumers outside the diff
    // in chain view a symbol expands to its edges (any node touching this id); otherwise to its drill-downs.
    const hasEdges = chainView && (model?.edges ?? []).some((e) => e.from === h.id || e.to === h.id);
    const expandable = hasEdges || (!chainView && ((h.externalRefs && h.externalRefs.length) || nsub || ncon || ncons || ct.links.length));
    // Codebase mode: a depth-2 `environment` node is the BOUNDARY FRONTIER (a consumer-of-a-consumer
    // — it uses the footprint but serves a different intent). Render it distinctly: a hollow, muted,
    // ripples-outward look so it reads as "the edge of the footprint", not an in-footprint member.
    const boundary = model?.mode === "codebase" && h.role === "environment";
    // mark-relevance: a link the LLM judged INCIDENTAL (connected but off the answer path) is kept
    // but DIMMED — muted icon + an "incidental" tag — never dropped, so completeness stays honest.
    const incidental = model?.mode === "codebase" && h.relevant === false;
    const pv = provTag(h);
    const it = new vscode.TreeItem(
      `${boundary ? "⤳ boundary" : h.role}${unc ? "?" : ""}${ext}  ·  ${hunkName(h)}${isModuleEntry(h) ? "" : ":" + h.start}`,
      expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const nlink = h.contract?.filter((c) => c.role === "link").length ?? 0;
    const desc = [boundary ? "ripple · 1 hop out" : "", incidental ? "incidental" : "",
                  ctTag, wireTargetTag(h),
                  h.caller ? `↑ called by ${h.label}` : "", pv, rw ? `↻ ${rw}` : "",
                  unc ? `uncertain ${confPct(h)}%` : "",
                  ncon ? `contract: ${nlink} link/${ncon - nlink} data` : "",
                  nsub ? `${nsub} proposed sub-cores` : "",
                  ncons ? `⇲ ${ncons} consumer${ncons > 1 ? "s" : ""} outside the diff` : ""]
                  .filter(Boolean).join("  ·  ");
    if (desc) it.description = desc;
    it.tooltip = boundary
      ? `boundary frontier — a consumer of a consumer (depth-2). It uses this footprint but serves ` +
        `a different intent; this is where the footprint ends.\n${h.file}:${h.start}-${h.end}`
      : (incidental ? `incidental wiring — connected to the footprint but judged OFF the answer path ` +
                      `for this intent; kept (not dropped), just dimmed.\n` : "") +
        (unc ? `${h.role}? — role vote was split (confidence ${confPct(h)}%); treat as a maybe`
             : h.role) +
        ` — ${h.file}:${h.start}-${h.end}` +
        (rw ? `\nre-routes ${rw}` : "") +
        (ext ? `\nwires outside the diff:${ext} (the §I boundary — go look there)` : "") +
        (ct.links.length ? `\n↔ inter-seam contract with ${ctPartners.join(", ")} — this block is a ` +
          `boundary crossing (${ct.links.length} bridging link${ct.links.length > 1 ? "s" : ""}); expand for the call-site/definition` : "");
    it.iconPath = boundary
      ? new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("descriptionForeground"))
      : incidental
      ? new vscode.ThemeIcon(ROLE_ICON[h.role] ?? "circle-small", new vscode.ThemeColor("descriptionForeground"))
      : pv   // a string-dispatch (partial) / suggested crossing → tinted so it reads as "go verify"
      ? new vscode.ThemeIcon(ROLE_ICON[h.role] ?? "circle-small",
          new vscode.ThemeColor(/SUGGEST/i.test(h.provenance ?? "") ? "charts.yellow" : "charts.orange"))
      : ctColor   // a contract endpoint → tint the role icon so the boundary block stands out
      ? new vscode.ThemeIcon(unc ? "question" : (ROLE_ICON[h.role] ?? "circle-small"), new vscode.ThemeColor(ctColor))
      : new vscode.ThemeIcon(unc ? "question" : (ROLE_ICON[h.role] ?? "circle-small"));
    it.command = { command: "seam.open", title: "Open", arguments: [h] };
    // P2/P3: a codebase-mode node can be EXPANDED — up (its consumers) or down (its dependencies).
    // The contextValue gates the expand menu; the command receives this tree Node and reads its hunk.
    if (model?.mode === "codebase" && (h.role === "link" || h.role === "environment" || h.role === "core")) {
      it.contextValue = "seamExpandable";
    }
    return it;
  }
}
