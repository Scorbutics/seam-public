// Port of src/diff/parser.py — parse a unified diff into Hunks (the unit of decomposition).
// The Python version wraps the `unidiff` library; here we parse git unified-diff text
// directly (no dependency), reproducing the fields the pipeline reads: source/target file,
// change_type, section_header, and the verbatim hunk text (incl. the @@ line).

export interface Span {
  role: string;
  lines: string; // "start-end" over the hunk body, 1-based inclusive
  rationale: string;
  seam: string;
  seam_label: string;
  wires: string[];
}

export function mkSpan(p: Partial<Span> & { role: string }): Span {
  return { role: p.role, lines: p.lines ?? "", rationale: p.rationale ?? "",
           seam: p.seam ?? "", seam_label: p.seam_label ?? "", wires: p.wires ?? [] };
}

export interface Placement {
  seam: string;
  role: string;
  start: number; // new-side file line (inclusive)
  end: number;
}

export interface Hunk {
  id: string;
  file_path: string;
  source_file: string;
  target_file: string;
  change_type: string; // add | delete | rename | modify | binary
  section_header: string;
  text: string;
  is_rename: boolean;
  is_binary: boolean;
  // filled in later stages:
  role: string | null;
  role_confidence: number;
  rationale: string;
  group: string;
  intent: string;
  seam: string;
  seam_label: string;
  wires: string[];
  spans: Span[];
  placements: Placement[];
  resolved_wires: string[];
  suggested_wires: string[];
}

export function mkHunk(p: Partial<Hunk> & {
  id: string; file_path: string; source_file: string; target_file: string;
  change_type: string; section_header: string; text: string;
}): Hunk {
  return {
    id: p.id, file_path: p.file_path, source_file: p.source_file, target_file: p.target_file,
    change_type: p.change_type, section_header: p.section_header, text: p.text,
    is_rename: p.is_rename ?? false, is_binary: p.is_binary ?? false,
    role: p.role ?? null, role_confidence: p.role_confidence ?? 1.0, rationale: p.rationale ?? "",
    group: p.group ?? "", intent: p.intent ?? "", seam: p.seam ?? "", seam_label: p.seam_label ?? "",
    wires: p.wires ?? [], spans: p.spans ?? [], placements: p.placements ?? [],
    resolved_wires: p.resolved_wires ?? [], suggested_wires: p.suggested_wires ?? [],
  };
}

export function headerLine(h: Hunk): string {
  return h.text ? h.text.split("\n")[0] : "";
}

// --- serialization (the post-classification intermediate state) --------------
export function hunksToJson(hunks: Hunk[]): string {
  return JSON.stringify(hunks, null, 2);
}

export function hunksFromJson(text: string): Hunk[] {
  const arr = JSON.parse(text) as any[];
  return arr.map((d) => mkHunk(d));
}

// --- the unified-diff parser (replaces unidiff.PatchSet) ---------------------
interface PatchedFile {
  sourceFile: string;   // "a/foo" | "/dev/null"
  targetFile: string;   // "b/foo" | "/dev/null"
  isRename: boolean;
  isBinary: boolean;
  pathHint: string;     // fallback display path from the `diff --git` line
  hunks: HunkAcc[];
}
interface HunkAcc { header: string; section: string; body: string[]; oldRem: number; newRem: number; }
const hunkDone = (h: HunkAcc) => h.oldRem <= 0 && h.newRem <= 0;

function displayPath(pf: PatchedFile): string {
  if (pf.targetFile && pf.targetFile !== "/dev/null")
    return pf.targetFile.startsWith("b/") ? pf.targetFile.slice(2) : pf.targetFile;
  if (pf.sourceFile && pf.sourceFile !== "/dev/null")
    return pf.sourceFile.startsWith("a/") ? pf.sourceFile.slice(2) : pf.sourceFile;
  return pf.pathHint || "<unknown>";
}

function changeType(pf: PatchedFile): string {
  if (pf.isBinary) return "binary";
  if (pf.sourceFile === "/dev/null") return "add";
  if (pf.targetFile === "/dev/null") return "delete";
  if (pf.isRename) return "rename";
  return "modify";
}

function splitFiles(diffText: string): PatchedFile[] {
  // Universal-newline split (like Python splitlines / unidiff): a CRLF or lone CR diff is
  // normalised to LF so the hunk text matches unidiff's `str(h)` byte-for-byte (LLM prompt parity).
  const lines = diffText.split(/\r\n|\r|\n/);
  const files: PatchedFile[] = [];
  let cur: PatchedFile | null = null;
  let curHunk: HunkAcc | null = null;

  const startFile = (pathHint: string) => {
    cur = { sourceFile: "", targetFile: "", isRename: false, isBinary: false, pathHint, hunks: [] };
    curHunk = null;
    files.push(cur);
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      startFile(m ? m[2] : "");
      continue;
    }
    if (!cur) {
      // Allow a bare diff with no `diff --git` header (e.g. plain `--- / +++`).
      if (line.startsWith("--- ")) startFile("");
      else continue;
    }
    const f = cur!;
    // Inside an UNSATISFIED hunk, every line is a body line — bound by the @@ counts (like unidiff),
    // so trailing/inter-hunk blank lines and the EOF newline artifact are never swept in. This must
    // run BEFORE the file-header checks (an added line may literally start with "+++"/"---").
    if (curHunk && !hunkDone(curHunk)) {
      if (line.startsWith("\\")) { curHunk.body.push(line); continue; }   // no-newline marker — no count
      const c = line[0];
      curHunk.body.push(line);
      if (c === "+") curHunk.newRem--;
      else if (c === "-") curHunk.oldRem--;
      else { curHunk.oldRem--; curHunk.newRem--; }                        // " " context, or blank line
      continue;
    }
    // A `\ No newline at end of file` marker can trail a just-satisfied hunk — still part of it.
    if (curHunk && line.startsWith("\\")) { curHunk.body.push(line); continue; }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) { f.isRename = true; curHunk = null; continue; }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { f.isBinary = true; curHunk = null; continue; }
    if (line.startsWith("--- ")) { f.sourceFile = line.slice(4).trim(); curHunk = null; continue; }
    if (line.startsWith("+++ ")) { f.targetFile = line.slice(4).trim(); curHunk = null; continue; }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(.*)$/);
      const oldRem = m && m[1] !== undefined ? parseInt(m[1], 10) : 1;
      const newRem = m && m[2] !== undefined ? parseInt(m[2], 10) : 1;
      curHunk = { header: line, section: m ? m[3].trim() : "", body: [], oldRem, newRem };
      f.hunks.push(curHunk);
      continue;
    }
    curHunk = null; // a satisfied hunk's trailing non-body line closes it
  }
  return files;
}

export function parse(diffText: string): Hunk[] {
  const patch = splitFiles(diffText);
  const hunks: Hunk[] = [];
  let counter = 0;

  for (const pf of patch) {
    const ct = changeType(pf);
    const display = displayPath(pf);

    if (ct === "binary" || pf.hunks.length === 0) {
      counter += 1;
      let note: string;
      if (ct === "binary") note = `binary change: ${display}`;
      else if (pf.isRename) {
        const src = pf.sourceFile.startsWith("a/") ? pf.sourceFile.slice(2) : pf.sourceFile;
        note = `pure rename: ${src} → ${display}`;
      } else note = `contentless change: ${display}`;
      hunks.push(mkHunk({
        id: `h${counter}`, file_path: display, source_file: pf.sourceFile, target_file: pf.targetFile,
        change_type: ct === "binary" ? "binary" : "rename", section_header: "", text: note,
        is_rename: pf.isRename, is_binary: ct === "binary",
      }));
      continue;
    }

    for (const h of pf.hunks) {
      counter += 1;
      const text = [h.header, ...h.body].join("\n");
      hunks.push(mkHunk({
        id: `h${counter}`, file_path: display, source_file: pf.sourceFile, target_file: pf.targetFile,
        change_type: ct, section_header: h.section, text, is_rename: pf.isRename, is_binary: false,
      }));
    }
  }
  return hunks;
}
