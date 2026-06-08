import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { computeSymbolFacts } from "./facts";
import { VSCodeSymbolResolver, buildResolvedGraph } from "./resolver";

// --- the JSON contract emitted by `decompose.py --emit-seams` ---
interface Rewire { removed: string[]; added: string[]; }
interface ExternalRef { symbol: string; source: string; }
interface SeamHunk { id: string; file: string; start: number; end: number; role: string; confidence?: number; external?: string[]; externalRefs?: ExternalRef[]; rewire?: Rewire | null; }
interface Seam { id: string; label: string; linkOnly: boolean; uncertain: boolean; warnings: string[]; hunks: SeamHunk[]; }
interface Cluster { id: string; intent: string; colorIndex: number; seams: Seam[]; }
// Codebase-mode adds honest-gap fields (the extension reads them additively; diff-mode
// omits them, so all are optional). `resolutionQuality` drives the honesty banner, and
// `unresolved`/`blindspots` are the UNKNOWN / statically-opaque overlays (plan §1/§2).
// Codebase mode's honest-gap overlays (plan §1/§2). A SUGGESTED candidate is NEVER a
// resolved edge — it's an unverified guess for a statically-opaque mechanism.
interface SuggestedCandidate { symbol: string; provenance: string; }
interface BlindSpot { node: string; mechanism: string; evidence: string; candidates: SuggestedCandidate[]; }
interface Unresolved { node: string; query: string; reason: string; }
interface SeamModel {
  clusters: Cluster[]; tests: SeamHunk[]; noise: SeamHunk[];
  mode?: string; anchor?: string; resolutionQuality?: string; language?: string;
  complete?: boolean; unresolved?: Unresolved[]; blindspots?: BlindSpot[];
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
// UNCERTAIN_THRESHOLD in renderer.py. The tool structures; the human judges.
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
let fileIndex: Map<string, IndexEntry[]> = new Map();   // repo-relative file → its hunk occurrences
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

  treeProvider = new SeamTreeProvider();
  treeView = vscode.window.createTreeView("seam.tree", { treeDataProvider: treeProvider });
  lensProvider = new SeamLensProvider();
  context.subscriptions.push(
    treeView,
    vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "git" }], lensProvider),
    vscode.commands.registerCommand("seam.review", () => runReview("HEAD")),
    vscode.commands.registerCommand("seam.reviewCommit", reviewCommit),
    vscode.commands.registerCommand("seam.analyzeCodebase", analyzeCodebase),
    vscode.commands.registerCommand("seam.clear", clearAll),
    vscode.commands.registerCommand("seam.showAll", showAll),
    vscode.commands.registerCommand("seam.next", (fromId?: string) => navStep(1, fromId)),
    vscode.commands.registerCommand("seam.prev", (fromId?: string) => navStep(-1, fromId)),
    vscode.commands.registerCommand("seam.open", openHunk),
    vscode.commands.registerCommand("seam.goToDef", goToDef),
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
  // resolved targets and the blind-spot overlay don't drive seam focus.
  if (sel && (sel.kind === "extTarget" || sel.kind === "shadows" || sel.kind === "blindspot"
              || sel.kind === "candidate" || sel.kind === "unknown")) return;
  if (!sel) { focusIds = null; focusLabel = ""; }
  else if (sel.kind === "seam" || sel.kind === "hunk") {
    focusIds = new Set(sel.seam.hunks.map(spanKey));
    focusLabel = sel.seam.label;
  } else if (sel.kind === "cluster") {
    focusIds = new Set(sel.cluster.seams.flatMap((s) => s.hunks.map(spanKey)));
    focusLabel = sel.cluster.intent;
  }
  rerender();
}

function showAll() {
  focusIds = null;
  focusLabel = "";
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
  treeView.message = focusIds
    ? `focus: ${focusLabel}  —  press the eye (Show all seams) to see everything`
    : lastRunBanner;
}

// Load a model into the view (tree + decorations + the "last run" message banner).
function activateModel(m: SeamModel, root: string, range: string, ts: number) {
  model = m;
  repoRoot = root;
  resolveCache.clear();       // a new run invalidates resolved external targets
  focusIds = null;            // a fresh/restored run starts showing all seams
  focusLabel = "";
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
  if (!model) return;
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
function execFileP(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
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

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: decomposing ${range}…` },
    async () => {
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
          factsPath = await buildAstFacts(py, tool, range);
          if (factsPath) extra.push("--facts", factsPath);
        }
        const args = [path.join(tool, "decompose.py"), "--git", range, "--repo", repoRoot,
                      "--emit-seams", out, ...extra];
        await execFileP(py, args, tool);
        const parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        const ts = Date.now();
        activateModel(parsed, repoRoot, range, ts);
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        vscode.window.showInformationMessage(
          `Seam (${engine}): ${parsed.clusters.length} clusters, ${n} seams.  ` +
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

// CODEBASE MODE (plan §3): decompose from an ANCHOR (the class/method under the cursor)
// instead of a diff. The VSCode SymbolResolver builds an anchor-bounded ResolvedGraph
// (Layer 1), Python decomposes it (`decompose.py --graph`, layers 3-6), and the SAME
// native renderer paints the result. The resolver output is the abstraction boundary —
// the engine never sees `vscode` (constraint §4).
async function analyzeCodebase() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("Seam: open a file and put the cursor on a class or method first.");
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showErrorMessage("Seam: open a folder/repo first."); return; }
  repoRoot = folder.uri.fsPath;
  const tool = toolPath();
  if (!fs.existsSync(path.join(tool, "decompose.py"))) {
    vscode.window.showErrorMessage(
      `Seam: decompose.py not found at "${tool}". Set "seam.toolPath" (Settings → Seam).`);
    return;
  }
  const py = pythonPath(tool);
  if (!fs.existsSync(py)) {
    vscode.window.showErrorMessage(`Seam: Python not found at "${py}". Set "seam.python" or create the venv.`);
    return;
  }
  const depth = vscode.workspace.getConfiguration("seam").get<number>("codebaseDepth") ?? 2;
  const anchorUri = editor.document.uri;
  const anchorPos = editor.selection.active;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Seam: analysing codebase from anchor…" },
    async () => {
      const graphPath = path.join(tool, `.seam-graph-${Date.now()}.json`);
      const out = path.join(tool, `.seam-${Date.now()}.json`);
      try {
        const graph = await buildResolvedGraph(new VSCodeSymbolResolver(), anchorUri, anchorPos,
                                               repoRoot, { maxDepth: depth });
        if (!graph.nodes.length || !graph.anchor.id) {
          vscode.window.showErrorMessage(
            "Seam: couldn't resolve a symbol here. Put the cursor on a class/method name and wait " +
            "for the language server to finish indexing (resolution: " + graph.resolutionQuality + ").");
          return;
        }
        fs.writeFileSync(graphPath, JSON.stringify(graph), "utf-8");
        await execFileP(py, [path.join(tool, "decompose.py"), "--graph", graphPath,
                             "--emit-seams", out], tool);
        const parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel;
        const ts = Date.now();
        const range = `anchor ${graph.anchor.symbol}`;
        activateModel(parsed, repoRoot, range, ts);
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        const gaps = (graph.unresolved.length || graph.blindspots.length)
          ? `  ·  ${graph.unresolved.length} unknown, ${graph.blindspots.length} blind spot(s)` : "";
        vscode.window.showInformationMessage(
          `Seam (codebase): ${graph.anchor.symbol} — ${parsed.clusters.length} clusters, ${n} seams.  ` +
          `resolution ${graph.resolutionQuality}${gaps}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Seam codebase analysis failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        try { fs.unlinkSync(graphPath); } catch { /* ignore */ }
        try { fs.unlinkSync(out); } catch { /* ignore */ }
      }
    },
  );
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
  try {
    await vscode.commands.executeCommand("git.openChange", uri); // native diff editor
  } catch {
    await vscode.window.showTextDocument(uri, { preview: true });
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.fsPath === uri.fsPath) {
    const line = Math.max(0, hunk.start - 1);
    const range = new vscode.Range(line, 0, line, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);
  }
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
  | { kind: "seam"; cluster: Cluster; seam: Seam }
  | { kind: "hunk"; cluster: Cluster; seam: Seam; hunk: SeamHunk }
  | { kind: "extTarget"; target: ExternalTarget }
  // codebase-mode blind-spot map (the differentiator): the statically-opaque mechanisms
  // and the UNKNOWN queries, surfaced separately from the resolved seams (plan §1/§6).
  | { kind: "shadows" }
  | { kind: "blindspot"; bs: BlindSpot }
  | { kind: "candidate"; cand: SuggestedCandidate }
  | { kind: "unknown"; ur: Unresolved };

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
      // The blind-spot map sits at the TOP LEVEL, beside the seams, so "where I'm blind"
      // is as visible as "what I resolved" (the differentiator — never buried).
      if (hasShadows(model)) roots.push({ kind: "shadows" });
      return roots;
    }
    if (el.kind === "shadows") {
      const out: Node[] = (model.blindspots ?? []).map((bs) => ({ kind: "blindspot", bs } as Node));
      return out.concat((model.unresolved ?? []).map((ur) => ({ kind: "unknown", ur } as Node)));
    }
    if (el.kind === "blindspot")
      return el.bs.candidates.map((cand) => ({ kind: "candidate", cand } as Node));
    if (el.kind === "cluster")
      return el.cluster.seams.map((seam) => ({ kind: "seam", cluster: el.cluster, seam }));
    if (el.kind === "seam")
      return el.seam.hunks.map((hunk) => ({ kind: "hunk", cluster: el.cluster, seam: el.seam, hunk }));
    if (el.kind === "hunk") {
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
      it.description = `${el.cluster.seams.length} seams`;
      return it;
    }
    if (el.kind === "seam") {
      const it = new vscode.TreeItem(el.seam.label, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = [el.seam.linkOnly ? "link-only" : "", el.seam.uncertain ? "uncertain" : ""]
        .filter(Boolean).join(" · ");
      it.iconPath = new vscode.ThemeIcon(el.seam.uncertain ? "question" : "git-merge");
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
    const it = new vscode.TreeItem(
      `${h.role}${unc ? "?" : ""}${ext}  ·  ${h.file.split("/").pop()}:${h.start}`,
      (h.externalRefs && h.externalRefs.length)
        ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const desc = [rw ? `↻ ${rw}` : "", unc ? `uncertain ${confPct(h)}%` : ""].filter(Boolean).join("  ·  ");
    if (desc) it.description = desc;
    it.tooltip =
      (unc ? `${h.role}? — role vote was split (confidence ${confPct(h)}%); treat as a maybe`
           : h.role) +
      ` — ${h.file}:${h.start}-${h.end}` +
      (rw ? `\nre-routes ${rw}` : "") +
      (ext ? `\nwires outside the diff:${ext} (the §I boundary — go look there)` : "");
    it.iconPath = new vscode.ThemeIcon(unc ? "question" : (ROLE_ICON[h.role] ?? "circle-small"));
    it.command = { command: "seam.open", title: "Open", arguments: [h] };
    return it;
  }
}
