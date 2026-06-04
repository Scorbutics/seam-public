import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";

// --- the JSON contract emitted by `decompose.py --emit-seams` ---
interface SeamHunk { id: string; file: string; start: number; end: number; role: string; }
interface Seam { id: string; label: string; linkOnly: boolean; uncertain: boolean; warnings: string[]; hunks: SeamHunk[]; }
interface Cluster { id: string; intent: string; colorIndex: number; seams: Seam[]; }
interface SeamModel { clusters: Cluster[]; tests: SeamHunk[]; noise: SeamHunk[]; }

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

let model: SeamModel | undefined;
let repoRoot = "";
let fileIndex: Map<string, SeamHunk[]> = new Map();   // repo-relative file → its hunks
let decoByRole: Record<string, vscode.TextEditorDecorationType> = {};
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

// Persisted per-workspace so the last run survives a window reload — no need to
// re-spend the LLM pass on the same diff.
const STATE_KEY = "seam.lastRun";
interface SavedRun { model: SeamModel; repoRoot: string; range: string; ts: number; }

export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  gutterDir = path.join(context.globalStorageUri.fsPath, "gutter");
  fs.mkdirSync(gutterDir, { recursive: true });
  for (const role of ROLES) decoByRole[role] = makeDecoration(ROLE_COLORS[role], role);

  treeProvider = new SeamTreeProvider();
  treeView = vscode.window.createTreeView("seam.tree", { treeDataProvider: treeProvider });
  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand("seam.review", () => runReview("HEAD")),
    vscode.commands.registerCommand("seam.reviewCommit", reviewCommit),
    vscode.commands.registerCommand("seam.clear", clearAll),
    vscode.commands.registerCommand("seam.showAll", showAll),
    vscode.commands.registerCommand("seam.open", openHunk),
    treeView.onDidChangeSelection(onSelect),
    vscode.window.onDidChangeVisibleTextEditors(applyToVisible),
  );
  restoreLast();
}

// Selecting a node FOCUSES it (seam or hunk → that seam; cluster → all its seams).
function onSelect(e: vscode.TreeViewSelectionChangeEvent<Node>) {
  const sel = e.selection[0];
  if (!sel) { focusIds = null; focusLabel = ""; }
  else if (sel.kind === "seam" || sel.kind === "hunk") {
    focusIds = new Set(sel.seam.hunks.map((h) => h.id));
    focusLabel = sel.seam.label;
  } else {
    focusIds = new Set(sel.cluster.seams.flatMap((s) => s.hunks.map((h) => h.id)));
    focusLabel = sel.cluster.intent;
  }
  applyToVisible(vscode.window.visibleTextEditors);
  updateBanner();
}

function showAll() {
  focusIds = null;
  focusLabel = "";
  applyToVisible(vscode.window.visibleTextEditors);
  updateBanner();
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
  focusIds = null;            // a fresh/restored run starts showing all seams
  focusLabel = "";
  lastRunBanner = `last run: ${range} · ${new Date(ts).toLocaleString()}`;
  buildIndex();
  treeProvider.refresh();
  applyToVisible(vscode.window.visibleTextEditors);
  updateBanner();
}

function restoreLast() {
  const saved = extContext.workspaceState.get<SavedRun>(STATE_KEY);
  const folder = vscode.workspace.workspaceFolders?.[0];
  // Only restore if it belongs to the folder currently open.
  if (saved && folder && saved.repoRoot === folder.uri.fsPath) {
    activateModel(saved.model, saved.repoRoot, saved.range, saved.ts);
  }
}

export function deactivate() {
  // Dispose decoration types only — do NOT wipe the persisted run (that's the cache).
  for (const role of ROLES) decoByRole[role]?.dispose();
}

// --- a gutter bar (SVG) + scrollbar overview mark, per ROLE colour ---
function makeDecoration(color: string, key: string): vscode.TextEditorDecorationType {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="18">` +
              `<rect x="1.5" width="3" height="18" rx="1" fill="${color}"/></svg>`;
  const file = path.join(gutterDir, `bar-${key}.svg`);
  fs.writeFileSync(file, svg, "utf-8");
  return vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(file),
    gutterIconSize: "contain",
    overviewRulerColor: color,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
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
  if (!model) return;
  const add = (h: SeamHunk) => {
    const list = fileIndex.get(h.file) ?? [];
    list.push(h);
    fileIndex.set(h.file, list);
  };
  for (const cl of model.clusters) for (const s of cl.seams) for (const h of s.hunks) add(h);
  model.tests.forEach(add);
  model.noise.forEach(add);
}

function runReview(range: string) {
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
  const out = path.join(tool, `.seam-${Date.now()}.json`);
  const args = [path.join(tool, "decompose.py"), "--git", range, "--repo", repoRoot, "--emit-seams", out];

  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Seam: decomposing ${range}…` },
    () => new Promise<void>((resolve) => {
      execFile(py, args, { cwd: tool, maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) { vscode.window.showErrorMessage(`Seam failed: ${stderr || err.message}`); resolve(); return; }
        let parsed: SeamModel;
        try { parsed = JSON.parse(fs.readFileSync(out, "utf-8")) as SeamModel; }
        catch (e) { vscode.window.showErrorMessage(`Seam: could not read output: ${e}`); resolve(); return; }
        try { fs.unlinkSync(out); } catch { /* ignore */ }
        const ts = Date.now();
        activateModel(parsed, repoRoot, range, ts);
        // Persist per-workspace so it restores on the next window open without re-running.
        extContext.workspaceState.update(STATE_KEY, { model: parsed, repoRoot, range, ts } as SavedRun);
        const n = parsed.clusters.reduce((a, c) => a + c.seams.length, 0);
        vscode.window.showInformationMessage(
          `Seam: ${parsed.clusters.length} clusters, ${n} seams.  ` +
          `core=amber · link=blue · environment=gray · test=green · noise=faint`);
        resolve();
      });
    }),
  );
}

// --- decorations: paint each visible editor's changed lines with its ROLE colour ---
function applyDecorations(editor: vscode.TextEditor) {
  // Only the working file / modified side of a diff (a `file:` doc). NEVER the
  // diff's base side (`git:`), whose old-side lines wouldn't match our new-side ranges.
  if (!model || !repoRoot || editor.document.uri.scheme !== "file") return;
  const rel = path.relative(repoRoot, editor.document.uri.fsPath).split(path.sep).join("/");
  const hunks = fileIndex.get(rel) ?? [];
  const byRole: Record<string, vscode.Range[]> = {};
  for (const role of ROLES) byRole[role] = [];
  for (const h of hunks) {
    if (focusIds && !focusIds.has(h.id)) continue;   // focus: hide other seams
    const start = Math.max(0, h.start - 1);
    const end = Math.max(start, h.end - 1);
    (byRole[h.role] ?? byRole.noise).push(new vscode.Range(start, 0, end, 0));
  }
  for (const role of ROLES) editor.setDecorations(decoByRole[role], byRole[role]);
}

function applyToVisible(editors: readonly vscode.TextEditor[]) { editors.forEach(applyDecorations); }

function clearAll() {
  model = undefined;
  fileIndex = new Map();
  for (const editor of vscode.window.visibleTextEditors)
    for (const role of ROLES) editor.setDecorations(decoByRole[role], []);
  treeProvider?.refresh();
  if (treeView) treeView.message = undefined;
  extContext?.workspaceState.update(STATE_KEY, undefined);  // forget the cached run
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

// --- the seam tree: clusters → seams → hunks (role shown by codicon + label) ---
type Node =
  | { kind: "cluster"; cluster: Cluster }
  | { kind: "seam"; cluster: Cluster; seam: Seam }
  | { kind: "hunk"; cluster: Cluster; seam: Seam; hunk: SeamHunk };

const ROLE_ICON: Record<string, string> = {
  core: "symbol-method", link: "link", environment: "symbol-field",
  test: "beaker", noise: "circle-slash",
};

class SeamTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  refresh() { this._onDidChange.fire(); }

  getChildren(el?: Node): Node[] {
    if (!model) return [];
    if (!el) return model.clusters.map((cluster) => ({ kind: "cluster", cluster }));
    if (el.kind === "cluster")
      return el.cluster.seams.map((seam) => ({ kind: "seam", cluster: el.cluster, seam }));
    if (el.kind === "seam")
      return el.seam.hunks.map((hunk) => ({ kind: "hunk", cluster: el.cluster, seam: el.seam, hunk }));
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
    const h = el.hunk;
    const it = new vscode.TreeItem(`${h.role}  ·  ${h.file.split("/").pop()}:${h.start}`,
      vscode.TreeItemCollapsibleState.None);
    it.tooltip = `${h.role} — ${h.file}:${h.start}-${h.end}`;
    it.iconPath = new vscode.ThemeIcon(ROLE_ICON[h.role] ?? "circle-small");
    it.command = { command: "seam.open", title: "Open", arguments: [h] };
    return it;
  }
}
