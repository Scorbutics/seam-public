import * as vscode from "vscode";
import { execFile, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { computeSymbolFacts } from "./facts";
import { VSCodeSymbolResolver, anchorSymbolAt, verifyMethodAttribution, MethodCandidate } from "./resolver";

// --- the JSON contract emitted by `decompose.py --emit-seams` ---
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
interface SeamHunk { id: string; file: string; start: number; end: number; role: string; label?: string; confidence?: number; relevant?: boolean; external?: string[]; externalRefs?: ExternalRef[]; rewire?: Rewire | null; subcores?: SubCore[]; contract?: ContractMember[]; provenance?: string; caller?: boolean; consumers?: Consumer[]; }
interface Seam { id: string; label: string; linkOnly: boolean; uncertain: boolean; warnings: string[]; hunks: SeamHunk[]; suggested?: boolean; }
// Altitude mid-level: a deterministic STRUCTURAL grouping of a big cluster's seams (by coupling +
// directory), so the reviewer collapses/expands groups to zoom. Absent on small/tight clusters.
interface SubGroup { label: string; seamIds: string[]; }
interface Cluster { id: string; intent: string; colorIndex: number; seams: Seam[]; subgroups?: SubGroup[]; }
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
interface SeamModel {
  clusters: Cluster[]; tests: SeamHunk[]; noise: SeamHunk[];
  usage?: Usage;     // tokens/cost of the LLM passes (claude backend only; absent for det/host runs)
  mode?: string; anchor?: string; resolutionQuality?: string; language?: string;
  complete?: boolean; unresolved?: Unresolved[]; blindspots?: BlindSpot[]; seamEdges?: SeamEdge[];
  edges?: GraphEdge[];     // the directed call/dependency graph — for the chain view
  seamContracts?: SeamContract[];   // the symbols bridging each pair of seams (the inter-seam contract)
  selectedSeam?: string;   // P1: the seam matching the user's intent (auto-focused), or ""
  autoGrown?: boolean;     // P5: an LLM-grown footprint — show it ALL (the growth is the answer), don't isolate
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
// A non-FULL edge into this node — a string-dispatch heuristic (RESOLVED_PARTIAL) or an LLM/assumed
// crossing (SUGGESTED): surface it so the node reads as a boundary to verify, not a hard import.
const provTag = (h: SeamHunk): string =>
  /SUGGEST/i.test(h.provenance ?? "") ? "~ suggested" : /PARTIAL/.test(h.provenance ?? "") ? "↝ dispatch (partial)" : "";
// Per-hunk role wash + a thinner, more-opaque outline (the border reads as the
// hunk's boundary; the fill is lighter so code stays legible over it).
const ROLE_BG_ALPHA = 0.19;      // line-background wash
const ROLE_BORDER_ALPHA = 0.75;  // hunk outline (more opaque than the fill)
function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

type TDeco = vscode.TextEditorDecorationType;
let model: SeamModel | undefined;
let repoRoot = "";
// P2 (expand): the accumulating ResolvedGraph for this session (a fresh analysis resets it; expanding
// a node merges its scan in). `sessionIntent` is re-applied on each expand so the focus persists.
const SESSION_GRAPH = ".seam-session-graph.json";
let sessionGraph: string | null = null;
let sessionIntent = "";
let fileIndex: Map<string, IndexEntry[]> = new Map();   // repo-relative file → its hunk occurrences
// Seam graph (S1): seam id → label, and seam id → its wired neighbours (resolved seam-to-seam).
let seamLabel: Map<string, string> = new Map();
let seamNeighbors: Map<string, { id: string; provenance: string }[]> = new Map();
let seamBounds: Map<string, { firstKey: string; lastKey: string }> = new Map();  // seam → its global first/last span occurrence
// Per role: a FILL (bg + gutter + ruler, all lines) and four position-specific
// BORDER types so the outline is drawn only around the hunk's perimeter (top edge
// on the first line, bottom on the last, sides throughout) — not a box per line.
let decoFill: Record<string, TDeco> = {};
// Per role: hunk-perimeter pieces (top/mid/bottom/single) + thick SEAM boundary
// pieces (seamTop on the seam's first line, seamBottom on its last line).
let decoBorder: Record<string, {
  top: TDeco; mid: TDeco; bottom: TDeco; single: TDeco; seamTop: TDeco; seamBottom: TDeco;
}> = {};
// GUTTER bar, separate from the fill so it can represent OVERLAP. A line's meaning is
// SEAM-DEPENDENT: the same lines can be `core` in their home seam AND `link` in a sibling
// seam (a container rendering a sibling component). In show-all (no focused seam) such a
// line carries >1 role, so its bar is SPLIT — one stripe per role — instead of an arbitrary
// single colour winning. Keyed by the sorted role-combo ("core" or "core|link"), built
// lazily; `gutterKeys` tracks them all so a re-paint can clear the stale ones first.
let decoGutter: Map<string, TDeco> = new Map();
// Model B: the PROPOSED sub-core overlay — deliberately DISTINCT from the solid role fills
// (a dashed violet outline), so a proposed grouping reads as a proposal, never as verified
// structure (R-B3). Painted only for the sub-core the user selects (opt-in), never in show-all.
let decoProposed: TDeco;
let activeProposed: { filePath: string; ranges: vscode.Range[] } | null = null;
let lensProvider: SeamLensProvider;
let gutterDir = "";
let treeProvider: SeamTreeProvider;
let treeView: vscode.TreeView<Node>;
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
  for (const role of ROLES) {
    const color = ROLE_COLORS[role];
    decoFill[role] = makeFillDecoration(color, role);
    decoBorder[role] = {
      top: makeBorderDecoration(color, "1px 1px 0 1px"),     // first line: top + sides
      mid: makeBorderDecoration(color, "0 1px 0 1px"),       // interior: sides only
      bottom: makeBorderDecoration(color, "0 1px 1px 1px"),  // last line: bottom + sides
      single: makeBorderDecoration(color, "1px"),            // one-line hunk: full box
      seamTop: makeBorderDecoration(color, "5px 0 0 0"),     // SEAM start: thick top
      seamBottom: makeBorderDecoration(color, "0 0 5px 0"),  // SEAM end: thick bottom
    };
  }

  decoProposed = vscode.window.createTextEditorDecorationType({
    border: "1px dashed rgba(163,113,247,0.9)",       // violet, dashed — "a proposal", not a fact
    backgroundColor: "rgba(163,113,247,0.10)",
    isWholeLine: true,
    overviewRulerColor: "rgba(163,113,247,0.85)",
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  treeProvider = new SeamTreeProvider();
  treeView = vscode.window.createTreeView("seam.tree", { treeDataProvider: treeProvider });
  lensProvider = new SeamLensProvider();
  context.subscriptions.push(
    treeView,
    vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "git" }], lensProvider),
    vscode.commands.registerCommand("seam.review", () => runReview("HEAD")),
    vscode.commands.registerCommand("seam.reviewCommit", reviewCommit),
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
}

function restoreLast() {
  const saved = extContext.workspaceState.get<SavedRun>(STATE_KEY);
  const folder = vscode.workspace.workspaceFolders?.[0];
  // Only restore if it belongs to the folder currently open.
  if (saved && folder && saved.repoRoot === folder.uri.fsPath) {
    activateModel(saved.model, saved.repoRoot, saved.range, saved.ts);
  }
}

// All decoration types for a role (fill + the four border pieces).
function allDecos(role: string): TDeco[] {
  const b = decoBorder[role];
  return [decoFill[role], b?.top, b?.mid, b?.bottom, b?.single, b?.seamTop, b?.seamBottom]
    .filter(Boolean) as TDeco[];
}

export function deactivate() {
  // Dispose decoration types only — do NOT wipe the persisted run (that's the cache).
  for (const role of ROLES) allDecos(role).forEach((d) => d.dispose());
  for (const d of decoGutter.values()) d.dispose();
  decoGutter.clear();
  decoProposed?.dispose();
}

// FILL: background wash + scrollbar mark on every line of the hunk. The gutter BAR is a
// separate decoration (see gutterFor) so an overlapping line can show a split bar.
function makeFillDecoration(color: string, _key: string): TDeco {
  return vscode.window.createTextEditorDecorationType({
    overviewRulerColor: color,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    backgroundColor: hexToRgba(color, ROLE_BG_ALPHA),
    isWholeLine: true,
  });
}

// GUTTER bar for a set of roles. One role → a solid bar; several (an OVERLAP) → vertical
// stripes, one per role, left→right in ROLES order (core amber, link blue, …) so the eye
// reads "core that also links" directly off the gutter. Cached by combo key.
function gutterFor(roles: string[]): TDeco {
  const ordered = ROLES.filter((r) => roles.includes(r));
  const key = ordered.join("|") || "noise";
  const hit = decoGutter.get(key);
  if (hit) return hit;
  const n = Math.max(1, ordered.length);
  const stripes = (ordered.length ? ordered : ["noise"]).map((r, i) => {
    const w = 3 / n;
    return `<rect x="${1.5 + i * w}" width="${w}" height="18" fill="${ROLE_COLORS[r] ?? "#c0c0c0"}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18">${stripes}</svg>`;
  const file = path.join(gutterDir, `bar-${key.replace(/\|/g, "_")}.svg`);
  fs.writeFileSync(file, svg, "utf-8");
  const deco = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(file),
    gutterIconSize: "contain",
    isWholeLine: true,
  });
  decoGutter.set(key, deco);
  return deco;
}

// BORDER: only the requested sides (CSS "top right bottom left"), so applying
// top→first line, sides→all, bottom→last line outlines the whole hunk, not each line.
function makeBorderDecoration(color: string, widthSpec: string): TDeco {
  return vscode.window.createTextEditorDecorationType({
    borderWidth: widthSpec,
    borderStyle: "solid",
    borderColor: hexToRgba(color, ROLE_BORDER_ALPHA),
    isWholeLine: true,
  });
}

// --- run the Python pipeline and load the seam model ---
function toolPath(): string {
  const cfg = vscode.workspace.getConfiguration("seam").get<string>("toolPath");
  return cfg && cfg.trim() ? cfg.trim() : path.resolve(__dirname, "..", "..");
}
function pythonPath(tool: string): string {
  const cfg = vscode.workspace.getConfiguration("seam").get<string>("python");
  return cfg && cfg.trim() ? cfg.trim() : path.join(tool, ".venv", "bin", "python");
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
  seamBounds = new Map();
  seamLabel = new Map();
  seamNeighbors = new Map();
  if (!model) return;
  for (const cl of model.clusters) for (const s of cl.seams) seamLabel.set(s.id, s.label);
  for (const e of model.seamEdges ?? []) {
    (seamNeighbors.get(e.from) ?? seamNeighbors.set(e.from, []).get(e.from)!).push({ id: e.to, provenance: e.provenance });
    (seamNeighbors.get(e.to) ?? seamNeighbors.set(e.to, []).get(e.to)!).push({ id: e.from, provenance: e.provenance });
  }
  const add = (e: IndexEntry) => {
    const list = fileIndex.get(e.hunk.file) ?? [];
    list.push(e);
    fileIndex.set(e.hunk.file, list);
  };
  for (const cl of model.clusters)
    for (const s of cl.seams) {
      // The seam's GLOBAL boundary (cross-file) = its first and last hunk in the
      // order the seam lists them (same order shown in the tree). The thick top
      // goes on the first hunk, the thick bottom on the last — wherever they live.
      if (s.hunks.length) {
        seamBounds.set(s.id, { firstKey: spanKey(s.hunks[0]), lastKey: spanKey(s.hunks[s.hunks.length - 1]) });
      }
      for (const h of s.hunks) add({ hunk: h, seamId: s.id, seamLabel: s.label, intent: cl.intent });
    }
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
    execFile(file, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

// Marker the Python pipeline writes to stderr at each phase boundary (src/core/progress.py).
// A long decompose spends ~2 min inside two LLM passes with no output, so we stream stderr,
// strip this prefix, and surface the message live in the progress notification.
const PROGRESS_PREFIX = "@@SEAM_PROGRESS@@";

// Like execFileP but spawns so stderr can be read live: each PROGRESS_PREFIX line is handed to
// `onProgress` as the next phase message. Still buffers stderr for the error message on failure.
function runPy(file: string, args: string[], cwd: string,
              onProgress?: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd });
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
      else reject(new Error(stderr.trim() || `decompose.py exited with code ${code}`));
    });
  });
}

// Engine "ast" (deterministic + VS Code AST facts): ask Python for the hunk skeleton
// (so facts are keyed by the SAME ids), compute defines/enclosing from the language
// server, write the partial facts payload, and return its path (for `--facts`). Returns
// undefined on any failure — the caller then runs deterministic with the regex base.
async function buildAstFacts(py: string, tool: string, range: string): Promise<string | undefined> {
  const skelPath = path.join(tool, `.seam-hunks-${Date.now()}.json`);
  try {
    await execFileP(py, [path.join(tool, "decompose.py"), "--git", range, "--repo", repoRoot,
                         "--emit-hunks", skelPath], tool);
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

async function runReview(range: string) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showErrorMessage("Seam: open a folder/repo first."); return; }
  repoRoot = folder.uri.fsPath;
  const tool = toolPath();
  if (!fs.existsSync(path.join(tool, "decompose.py"))) {
    vscode.window.showErrorMessage(
      `Seam: decompose.py not found at "${tool}". Set "seam.toolPath" to your ` +
      `code-review-sort checkout (Settings → Seam).`);
    return;
  }
  const py = pythonPath(tool);
  if (!fs.existsSync(py)) {
    vscode.window.showErrorMessage(`Seam: Python not found at "${py}". Set "seam.python" or create the venv.`);
    return;
  }
  // Engine: "hybrid" (default — LLM clusters + deterministic roles/wiring, fed VS Code AST
  // facts), "det" (fully deterministic, offline), or "llm" (all LLM).
  const engine = vscode.workspace.getConfiguration("seam").get<string>("engine") || "hybrid";
  // Codebase context (on by default): resolve the diff's references against the real repo so the
  // review shows blast radius (who outside the diff consumes a changed symbol). The LSP daemon stays
  // warm across reviews, so 'auto' (floor + LSP) is the right default here.
  const resolver = vscode.workspace.getConfiguration("seam").get<string>("resolver") || "auto";
  const blastRadius = vscode.workspace.getConfiguration("seam").get<boolean>("blastRadius") ?? true;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: decomposing ${range}…` },
    async (progress) => {
      const out = path.join(tool, `.seam-${Date.now()}.json`);
      let factsPath: string | undefined;
      try {
        const extra: string[] = [];
        if (engine === "llm") {
          extra.push("--classifier", "llm");
        } else {
          // hybrid (default) or det: deterministic roles; cluster = LLM for hybrid, det for
          // det. Wiring is 'hybrid' (det + LLM prune of over-wired containers) for the hybrid
          // engine, 'det' for the offline engine. Feed the editor's AST facts to the det
          // passes (missing facts → regex base, so no warning needed).
          const det = engine === "det";
          extra.push("--cluster", det ? "det" : "llm", "--roles", "det",
                     "--wiring", det ? "det" : "hybrid");
          progress.report({ message: "Computing code facts…" });
          factsPath = await buildAstFacts(py, tool, range);
          if (factsPath) extra.push("--facts", factsPath);
        }
        if (resolver !== "det") extra.push("--resolver", resolver);
        if (blastRadius) extra.push("--blast-radius");
        const args = [path.join(tool, "decompose.py"), "--git", range, "--repo", repoRoot,
                      "--emit-seams", out, ...extra];
        await runPy(py, args, tool, (m) => progress.report({ message: m }));
        const parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        const ts = Date.now();
        activateModel(parsed, repoRoot, range, ts);
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        vscode.window.showInformationMessage(
          `Seam (${engine}): ${parsed.clusters.length} clusters, ${n} seams.${usageNote(parsed.usage)}  ` +
          `core=amber · link=blue · environment=gray · test=green · noise=faint`);
      } catch (e) {
        vscode.window.showErrorMessage(`Seam failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        try { fs.unlinkSync(out); } catch { /* ignore */ }
        if (factsPath) { try { fs.unlinkSync(factsPath); } catch { /* ignore */ } }
      }
    },
  );
}

// CODEBASE MODE (plan §3): decompose from an ANCHOR (a symbol, or a whole module) instead of a
// diff. Consumer discovery is the deterministic import scan (`decompose.py --scan` — monorepo-safe,
// offline; LSP find-references is project-scoped/blind, see resolver.ts). The SAME native renderer
// paints the SeamModel; the engine never sees `vscode` (constraint §4).

// Shared env guard: workspace folder + decompose.py + python. Sets repoRoot; null (after an error
// message) if anything is missing.
function codebaseEnv(): { tool: string; py: string } | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showErrorMessage("Seam: open a folder/repo first."); return null; }
  repoRoot = folder.uri.fsPath;
  const tool = toolPath();
  if (!fs.existsSync(path.join(tool, "decompose.py"))) {
    vscode.window.showErrorMessage(
      `Seam: decompose.py not found at "${tool}". Set "seam.toolPath" (Settings → Seam).`);
    return null;
  }
  const py = pythonPath(tool);
  if (!fs.existsSync(py)) {
    vscode.window.showErrorMessage(`Seam: Python not found at "${py}". Set "seam.python" or create the venv.`);
    return null;
  }
  return { tool, py };
}

// Run `decompose.py --scan` with the given anchor args (single-symbol or whole-module) and paint
// the result. --classifier (seam.engine) decides the partition: 'det' = floor only; 'hybrid'/'llm'
// = LLM-refined intent labels (proposed).
async function runScan(tool: string, py: string, scanArgs: string[], title: string, range: string) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    async (progress) => {
      const out = path.join(tool, `.seam-${Date.now()}.json`);
      const graph = path.join(tool, SESSION_GRAPH);   // P2: persisted ResolvedGraph for expansion
      try {
        const engine = vscode.workspace.getConfiguration("seam").get<string>("engine") || "hybrid";
        await runPy(py, [path.join(tool, "decompose.py"), "--scan", "--repo", repoRoot,
                         ...scanArgs, "--classifier", engine, "--emit-graph", graph, "--emit-seams", out],
                    tool, (m) => progress.report({ message: m }));
        const parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        sessionGraph = graph;                          // fresh analysis = new session to grow from
        const ts = Date.now();
        activateModel(parsed, repoRoot, range, ts);
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        vscode.window.showInformationMessage(
          `Seam (codebase): ${range} — ${parsed.clusters.length} cluster(s), ${n} seam(s).${usageNote(parsed.usage)}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Seam codebase analysis failed: ${e instanceof Error ? e.message : e}`);
      } finally {
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
    // precision path), with the tree-sitter heuristic as the degrade fallback.
    await runScanClass(env.tool, env.py, anchor, depth);
  } else {
    await runScan(env.tool, env.py,
                  ["--anchor-file", anchor.file, "--symbol", anchor.symbol, "--depth", String(depth)],
                  `Seam: scanning consumers of ${anchor.symbol}…`, `anchor ${anchor.symbol}`);
  }
}

// CLASS anchor — the LSP-verified method-attribution flow (3 phases): (1) Python emits the method
// call-site candidates; (2) the LSP go-to-defs each to confirm it binds to the anchor class; (3)
// Python rebuilds with the verified attribution (RESOLVED_FULL). If the LSP confirms nothing
// (no provider / mid-indexing), it falls back to the tree-sitter heuristic (RESOLVED_PARTIAL).
async function runScanClass(tool: string, py: string,
                            anchor: { symbol: string; file: string }, depth: number, intent?: string) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: resolving methods of ${anchor.symbol}…` },
    async (progress) => {
      const cand = path.join(tool, `.seam-cand-${Date.now()}.json`);
      const attr = path.join(tool, `.seam-attr-${Date.now()}.json`);
      const out = path.join(tool, `.seam-${Date.now()}.json`);
      try {
        const engine = vscode.workspace.getConfiguration("seam").get<string>("engine") || "hybrid";
        const base = [path.join(tool, "decompose.py"), "--scan", "--repo", repoRoot,
                      "--anchor-file", anchor.file, "--symbol", anchor.symbol];
        // phase 1 — candidates
        progress.report({ message: "Finding method call-sites…" });
        await execFileP(py, [...base, "--emit-candidates", cand], tool);
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
        await runPy(py, [...base, ...scanArgs, "--classifier", engine, "--emit-graph", graph, "--emit-seams", out],
                    tool, (m) => progress.report({ message: m }));
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
// puts decompose.py --scan into module mode.
async function analyzeModule() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showErrorMessage("Seam: open the module file you want to analyse first."); return; }
  const env = codebaseEnv();
  if (!env) return;
  const file = path.relative(repoRoot, editor.document.uri.fsPath).split(path.sep).join("/");
  const base = path.basename(file);
  sessionIntent = "";
  await runScan(env.tool, env.py, ["--anchor-file", file],
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
    { location: vscode.ProgressLocation.Notification, title: `Seam: expanding to the ${dir} ${symbol}…` },
    async (progress) => {
      const out = path.join(env.tool, `.seam-${Date.now()}.json`);
      try {
        const engine = vscode.workspace.getConfiguration("seam").get<string>("engine") || "hybrid";
        // read the session graph AND write the grown one back to it (decompose loads before writing)
        const args = [path.join(env.tool, "decompose.py"), "--expand-graph", sessionGraph!, "--repo", repoRoot,
                      "--expand-file", h.file, "--expand-symbol", symbol, "--expand-line", String(h.start),
                      "--depth", String(depth), "--classifier", engine, "--emit-graph", sessionGraph!, "--emit-seams", out];
        if (down) args.push("--down");
        if (crossNote) args.push("--cross-from", crossNote);
        if (sessionIntent) args.push("--intent", sessionIntent);
        await runPy(env.py, args, env.tool, (m) => progress.report({ message: m }));
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
    await execFileP(env.py, ["-m", "src.codebase.anchor_rank", "--crossings", "--intent", symbol,
                             "--repo", repoRoot, "--exclude-file", h.file, "--out", out], env.tool);
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

// FUZZY ENTRY RAMP (plan P3): describe an intent → workspaceSymbol candidates → Python ranks them →
// the user CONFIRMS one → the deterministic footprint attaches to the confirmed anchor (the brief's
// invariant: the guarantee attaches only AFTER confirmation, never from an unconfirmed match).
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

  const picked = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: finding anchors for “${intent}”…` },
    async (): Promise<{ symbol: string; file: string; kind: string } | undefined> => {
      // Candidate discovery is a DETERMINISTIC repo scan (Python), not workspaceSymbol — the LSP
      // workspace-symbol search is project-scoped / depends on what's loaded (the same flakiness we
      // pivoted off for find-references), so it would miss symbols in unopened files.
      const ranked = path.join(env.tool, `.seam-rank-${Date.now()}.json`);
      let items: Array<{ name: string; file: string; kind: string; terms?: string[] }> = [];
      try {
        await execFileP(env.py, ["-m", "src.codebase.anchor_rank", "--intent", intent, "--repo", repoRoot, "--out", ranked], env.tool);
        items = JSON.parse(fs.readFileSync(ranked, "utf-8"));
      } finally {
        try { fs.unlinkSync(ranked); } catch { /* ignore */ }
      }
      if (!items.length) {
        vscode.window.showWarningMessage(`Seam: no anchors matched “${intent}”. Try a keyword that appears in the code.`);
        return undefined;
      }
      const pick = await vscode.window.showQuickPick(
        items.map((c) => ({
          label: c.name,
          description: c.kind,
          detail: c.file + (c.terms?.length ? `   · matched: ${c.terms.join(", ")}` : ""),
          anchor: { symbol: c.name, file: c.file, kind: c.kind },
        })),
        { title: `Anchors for “${intent}” — pick one to map its footprint`, matchOnDetail: true, ignoreFocusOut: true },
      );
      return pick?.anchor;
    },
  );
  if (!picked) return;

  const depth = vscode.workspace.getConfiguration("seam").get<number>("codebaseDepth") ?? 2;
  if (auto) {
    // P5: the LLM grows the footprint toward the question (picks node + up/down each step), then focuses.
    await runScan(env.tool, env.py,
                  ["--anchor-file", picked.file, "--symbol", picked.symbol, "--intent", intent,
                   "--auto", "--max-steps", "3"],
                  `Seam: auto-growing the footprint for “${intent}”…`, `auto · ${picked.symbol}`);
  } else if (picked.kind === "class") {
    await runScanClass(env.tool, env.py, picked, depth, intent);   // intent focuses the matching seam
  } else {
    await runScan(env.tool, env.py,
                  ["--anchor-file", picked.file, "--symbol", picked.symbol, "--depth", String(depth),
                   "--intent", intent],
                  `Seam: scanning consumers of ${picked.symbol}…`, `anchor ${picked.symbol}`);
  }
}
const autoMapIntent = () => analyzeFromIntent(true);

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

// --- decorations: paint each visible editor's changed lines with its ROLE colour ---
function applyDecorations(editor: vscode.TextEditor) {
  if (!model) return;
  const rel = modifiedRelPath(editor.document.uri);
  if (rel === null) return;
  const entries = fileIndex.get(rel) ?? [];
  const fill: Record<string, vscode.Range[]> = {};
  const top: Record<string, vscode.Range[]> = {};
  const mid: Record<string, vscode.Range[]> = {};
  const bottom: Record<string, vscode.Range[]> = {};
  const single: Record<string, vscode.Range[]> = {};
  for (const role of ROLES) { fill[role] = []; top[role] = []; mid[role] = []; bottom[role] = []; single[role] = []; }
  const line = (n: number) => new vscode.Range(n, 0, n, 0);
  // Per editor line, the SET of roles covering it (across overlapping seam placements of
  // the same hunk) — drives the gutter bar (split where >1 role) so overlap is visible.
  const lineRoles: Map<number, Set<string>> = new Map();
  for (const { hunk: h } of entries) {
    if (focusIds && !focusIds.has(spanKey(h))) continue;   // focus: hide other seams/spans
    const role = ROLES.includes(h.role) ? h.role : "noise";
    const s = Math.max(0, h.start - 1);
    const e = Math.max(s, h.end - 1);
    fill[role].push(new vscode.Range(s, 0, e, 0));    // wash on every line
    for (let n = s; n <= e; n++) (lineRoles.get(n) ?? lineRoles.set(n, new Set()).get(n)!).add(role);
    if (e === s) {
      single[role].push(line(s));                     // one-line hunk: full box
    } else {
      top[role].push(line(s));
      bottom[role].push(line(e));
      if (e > s + 1) mid[role].push(new vscode.Range(s + 1, 0, e - 1, 0));
    }
  }
  // GUTTER bars by role-combo: a line with one role gets a solid bar; an overlap line
  // gets a split bar. Clear every previously-painted combo first so stale bars vanish.
  const byCombo: Map<string, vscode.Range[]> = new Map();
  for (const [n, roles] of lineRoles) {
    const key = ROLES.filter((r) => roles.has(r)).join("|") || "noise";
    (byCombo.get(key) ?? byCombo.set(key, []).get(key)!).push(line(n));
  }
  for (const deco of decoGutter.values()) editor.setDecorations(deco, []);
  for (const [key, ranges] of byCombo) editor.setDecorations(gutterFor(key.split("|")), ranges);
  // SEAM boundaries (CROSS-FILE): the thick top sits on the seam's GLOBAL first
  // hunk and the thick bottom on its GLOBAL last hunk (seam-canonical order, same as
  // the tree) — so a file only shows the bracket edge if it contains that boundary
  // hunk; middle files get none.
  const seamTop: Record<string, vscode.Range[]> = {};
  const seamBottom: Record<string, vscode.Range[]> = {};
  for (const role of ROLES) { seamTop[role] = []; seamBottom[role] = []; }
  const roleOf = (h: SeamHunk) => (ROLES.includes(h.role) ? h.role : "noise");
  // Only the FOCUSED seam gets a boundary bracket — in show-all, brackets from many
  // (interleaving) seams would overlap; focus is where a single clean bracket reads.
  if (focusIds) {
    for (const e of entries) {
      if (!focusIds.has(spanKey(e.hunk))) continue;
      const b = e.seamId ? seamBounds.get(e.seamId) : undefined;
      if (!b) continue;
      if (spanKey(e.hunk) === b.firstKey) seamTop[roleOf(e.hunk)].push(line(Math.max(0, e.hunk.start - 1)));
      if (spanKey(e.hunk) === b.lastKey) seamBottom[roleOf(e.hunk)].push(line(Math.max(0, e.hunk.end - 1)));
    }
  }

  for (const role of ROLES) {
    editor.setDecorations(decoFill[role], fill[role]);
    editor.setDecorations(decoBorder[role].top, top[role]);
    editor.setDecorations(decoBorder[role].mid, mid[role]);
    editor.setDecorations(decoBorder[role].bottom, bottom[role]);
    editor.setDecorations(decoBorder[role].single, single[role]);
    editor.setDecorations(decoBorder[role].seamTop, seamTop[role]);
    editor.setDecorations(decoBorder[role].seamBottom, seamBottom[role]);
  }
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
    for (const role of ROLES) allDecos(role).forEach((d) => editor.setDecorations(d, []));
    for (const d of decoGutter.values()) editor.setDecorations(d, []);
  }
  clearProposed();
  treeProvider?.refresh();
  lensProvider?.refresh();
  if (treeView) treeView.message = undefined;
  vscode.commands.executeCommand("setContext", "seam.active", false);
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
type Node =
  | { kind: "cluster"; cluster: Cluster }
  | { kind: "subgroup"; cluster: Cluster; group: SubGroup }
  | { kind: "seam"; cluster: Cluster; seam: Seam }
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
  // The inter-seam CONTRACT layer: the section, one seam-pair, one bridging link, and its two ends
  // (the CALLER at the call-site, and the CALLEE at its definition) so both sides are reachable.
  | { kind: "contracts" }
  | { kind: "contractPair"; contract: SeamContract }
  | { kind: "contractLink"; link: GraphEdge }
  | { kind: "contractEnd"; side: "from" | "to"; link: GraphEdge };

// A3: lazy cache of "where does this fed value come from" (one more hop up the chain).
const feedDefCache = new Map<string, Promise<{ uri: vscode.Uri; line: number }[]>>();

// Find a rendered hunk by node id (for navigating to a blind spot's location).
function findHunkById(id: string): SeamHunk | undefined {
  if (!model) return undefined;
  for (const cl of model.clusters) for (const s of cl.seams) for (const h of s.hunks) if (h.id === id) return h;
  return model.tests.find((h) => h.id === id);
}
const hasShadows = (m: SeamModel): boolean =>
  m.mode === "codebase" && !!((m.blindspots?.length ?? 0) + (m.unresolved?.length ?? 0));

const ROLE_ICON: Record<string, string> = {
  core: "symbol-method", link: "link", environment: "symbol-field",
  test: "beaker", noise: "circle-slash",
};

class SeamTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  refresh() { this._onDidChange.fire(); }

  getChildren(el?: Node): Node[] | Promise<Node[]> {
    if (!model) return [];
    if (!el) {
      const roots: Node[] = model.clusters.map((cluster) => ({ kind: "cluster", cluster }));
      // The inter-seam CONTRACT layer sits BETWEEN the seams and the blind spots — its own dedicated
      // space (the symbols bridging seam pairs), so the boundary a reviewer must validate is explicit.
      if (model.seamContracts?.length) roots.push({ kind: "contracts" });
      // The blind-spot map sits at the TOP LEVEL, beside the seams, so "where I'm blind"
      // is as visible as "what I resolved" (the differentiator — never buried).
      if (hasShadows(model)) roots.push({ kind: "shadows" });
      return roots;
    }
    if (el.kind === "contracts")
      return (model.seamContracts ?? []).map((contract) => ({ kind: "contractPair", contract } as Node));
    if (el.kind === "contractPair")
      return el.contract.links.map((link) => ({ kind: "contractLink", link } as Node));
    if (el.kind === "contractLink")
      return [{ kind: "contractEnd", side: "from", link: el.link } as Node,
              { kind: "contractEnd", side: "to", link: el.link } as Node];
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
      // Altitude: a big cluster shows its SUB-GROUPS (collapsed by default = overview); expand one
      // to drill into its seams. Small/tight clusters have no subgroups → seams directly.
      if (el.cluster.subgroups?.length)
        return el.cluster.subgroups.map((group) => ({ kind: "subgroup", cluster: el.cluster, group }));
      return el.cluster.seams.map((seam) => ({ kind: "seam", cluster: el.cluster, seam }));
    }
    if (el.kind === "subgroup") {
      const ids = new Set(el.group.seamIds);
      return el.cluster.seams.filter((s) => ids.has(s.id))
        .map((seam) => ({ kind: "seam", cluster: el.cluster, seam }));
    }
    if (el.kind === "seam") {
      // the seam's resolved wiring (other seams it connects to) shows first, then its hunks.
      const links: Node[] = (seamNeighbors.get(el.seam.id) ?? [])
        .map((n) => ({ kind: "seamLink", toId: n.id, provenance: n.provenance } as Node));
      const hunks: Node[] = el.seam.hunks.map((hunk) => ({ kind: "hunk", cluster: el.cluster, seam: el.seam, hunk }));
      return [...links, ...hunks];
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
      it.iconPath = new vscode.ThemeIcon("symbol-color");
      const nsub = el.cluster.subgroups?.length ?? 0;
      it.description = nsub ? `${nsub} groups · ${el.cluster.seams.length} seams` : `${el.cluster.seams.length} seams`;
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
    if (el.kind === "seam") {
      const sug = el.seam.suggested === true;   // reached only across a heuristic crossing (string-dispatch/assumed)
      const it = new vscode.TreeItem(sug ? `↝ ${el.seam.label}` : el.seam.label, vscode.TreeItemCollapsibleState.Collapsed);
      const wired = seamNeighbors.get(el.seam.id)?.length ?? 0;
      it.description = [sug ? "suggested seam" : "", el.seam.linkOnly ? "link-only" : "",
                        el.seam.uncertain ? "uncertain" : "", wired ? `↔ ${wired}` : ""].filter(Boolean).join(" · ");
      it.iconPath = sug
        ? new vscode.ThemeIcon("git-merge", new vscode.ThemeColor("charts.orange"))   // a boundary to verify
        : new vscode.ThemeIcon(el.seam.uncertain ? "question" : "git-merge");
      it.tooltip = sug
        ? `A SUGGESTED seam — the other side of a boundary crossed by heuristic (a string-dispatch / `
          + `assumed link, not a hard import). The chain reaches it, but go verify the crossing.`
        : undefined;
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
    if (el.kind === "contracts") {
      const cs = model?.seamContracts ?? [];
      const blurry = cs.filter((c) => c.blurry).length;
      const it = new vscode.TreeItem("Seam contracts", vscode.TreeItemCollapsibleState.Expanded);
      it.description = `${cs.length} between seams${blurry ? ` · ${blurry} blurry` : ""}`;
      it.iconPath = new vscode.ThemeIcon("git-compare", blurry ? new vscode.ThemeColor("charts.yellow") : undefined);
      it.tooltip = "The CONTRACT between seams — the symbols that bridge each pair of intents, and how " +
        "solid the link is. A BLURRY contract (heuristic / assumed edges) is the boundary to eyeball.";
      return it;
    }
    if (el.kind === "contractPair") {
      const c = el.contract;
      const a = seamLabel.get(c.seamA) ?? c.seamA, b = seamLabel.get(c.seamB) ?? c.seamB;
      const it = new vscode.TreeItem(`${a}  ↔  ${b}`, vscode.TreeItemCollapsibleState.Expanded);
      it.description = `${c.links.length} link${c.links.length > 1 ? "s" : ""}${c.blurry ? "  ·  ⚠ blurry" : ""}`;
      it.iconPath = new vscode.ThemeIcon(c.blurry ? "warning" : "arrow-both",
        new vscode.ThemeColor(c.blurry ? "charts.yellow" : "charts.green"));
      it.tooltip = c.blurry
        ? `"${a}" and "${b}" are linked by HEURISTIC/assumed edges — a blurry contract to validate.`
        : `"${a}" and "${b}" are linked by resolved edges.`;
      return it;
    }
    if (el.kind === "contractLink") {
      // expandable to BOTH ends — the caller (call-site) and the callee (definition) — so you can see
      // where one seam reaches into the other, not just the symbol's implementation.
      const l = el.link;
      const from = findHunkById(l.from), to = findHunkById(l.to);
      const partial = /PARTIAL/.test(l.provenance), suggested = /SUGGEST/i.test(l.provenance);
      const it = new vscode.TreeItem(`${from?.label ?? l.from} → ${to?.label ?? l.to}`, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${l.kind} · ${suggested ? "SUGGESTED" : partial ? "RESOLVED (partial)" : "RESOLVED"}`;
      it.iconPath = new vscode.ThemeIcon(suggested ? "lightbulb" : partial ? "kebab-horizontal" : "arrow-right",
        new vscode.ThemeColor(suggested ? "charts.yellow" : partial ? "charts.orange" : "charts.green"));
      it.tooltip = `${from?.label ?? l.from} → ${to?.label ?? l.to}\nrelation: ${l.kind} · ${l.provenance}` +
        "\nexpand to jump to the call-site (caller) or the definition (callee)";
      return it;
    }
    if (el.kind === "contractEnd") {
      const l = el.link;
      const fromH = findHunkById(l.from), toH = findHunkById(l.to);
      if (el.side === "from") {
        // the CALLER side — jump to the exact call-site (call line in the caller's file) if known.
        const line = l.line && l.line > 0 ? l.line : (fromH?.start ?? 0);
        const it = new vscode.TreeItem(`← called from ${fromH?.label ?? l.from}`, vscode.TreeItemCollapsibleState.None);
        it.description = fromH ? `${fromH.file.split("/").pop()}:${line}` : l.from;
        it.iconPath = new vscode.ThemeIcon("arrow-small-left", new vscode.ThemeColor("charts.blue"));
        it.tooltip = `where ${fromH?.label ?? l.from} calls ${toH?.label ?? l.to} (the seam boundary crossing)`;
        if (fromH) it.command = { command: "seam.open", title: "Open call-site",
          arguments: [{ ...fromH, start: line, end: line }] };
        return it;
      }
      const it = new vscode.TreeItem(`→ ${toH?.label ?? l.to} (definition)`, vscode.TreeItemCollapsibleState.None);
      it.description = toH ? `${toH.file.split("/").pop()}:${toH.start}` : l.to;
      it.iconPath = new vscode.ThemeIcon("symbol-method", new vscode.ThemeColor("charts.green"));
      it.tooltip = `the definition of ${toH?.label ?? l.to}`;
      if (toH) it.command = { command: "seam.open", title: "Open definition", arguments: [toH] };
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
    const unc = isUncertain(h);
    const ext = extTag(h);
    const rw = rewireStr(h);
    const ncon = h.contract?.length ?? 0, nsub = h.subcores?.length ?? 0;
    const ncons = h.consumers?.length ?? 0;   // blast radius: consumers outside the diff
    // in chain view a symbol expands to its edges (any node touching this id); otherwise to its drill-downs.
    const hasEdges = chainView && (model?.edges ?? []).some((e) => e.from === h.id || e.to === h.id);
    const expandable = hasEdges || (!chainView && ((h.externalRefs && h.externalRefs.length) || nsub || ncon || ncons));
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
        (ext ? `\nwires outside the diff:${ext} (the §I boundary — go look there)` : "");
    it.iconPath = boundary
      ? new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("descriptionForeground"))
      : incidental
      ? new vscode.ThemeIcon(ROLE_ICON[h.role] ?? "circle-small", new vscode.ThemeColor("descriptionForeground"))
      : pv   // a string-dispatch (partial) / suggested crossing → tinted so it reads as "go verify"
      ? new vscode.ThemeIcon(ROLE_ICON[h.role] ?? "circle-small",
          new vscode.ThemeColor(/SUGGEST/i.test(h.provenance ?? "") ? "charts.yellow" : "charts.orange"))
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
