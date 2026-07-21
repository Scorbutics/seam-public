// Port of src/codebase/string_coupling.py — tier-2 of the edge ladder: STRING-DISPATCH couplings
// (x.invoke("process-payment") → **/process-payment/index.*) → RESOLVED_PARTIAL. Framework-agnostic:
// find a distinctive string in a call, match a UNIQUE existing module entry. Conventions (what marks
// an entry, where the entrypoint is) live in the language providers.
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { type Ctx, makeCtx, available, lang_for, _CALL } from "../../atoms.js";
import { entrypoint_line, is_module_entry, SKIP_DIRS } from "../../../core/resolve/languages/index.js";
import { walk } from "../../../core/resolve/walk.js";
import { recordRead, recordQuery, registerQueryRerun, hashSet } from "../../../core/resolve/dep_recorder.js";

const _NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,}$/;
const _MULTISEGMENT = /[-_]/;
const _ENTRY_CACHE = new Map<string, Map<string, string[]>>();

export function module_entry_index(repo: string, skipDirs: Set<string>): Map<string, string[]> {
  if (_ENTRY_CACHE.has(repo)) return _ENTRY_CACHE.get(repo)!;
  const idx = new Map<string, string[]>();
  for (const [dir, files] of walk(repo, skipDirs)) {
    const entry = files.find((f) => is_module_entry(f));
    if (entry) {
      const k = basename(dir);
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k)!.push(relative(repo, join(dir, entry)));
    }
  }
  _ENTRY_CACHE.set(repo, idx);
  return idx;
}
// The module-entry SET is a filename-only walk (dir basename → entry files) — a content edit never changes it, so
// this is recorded as a precise membership query (NOT a whole-repo epoch dep): a footprint that consulted it misses
// only when a module-entry file is added/removed, not on every save.
function _entryKeys(idx: Map<string, string[]>): string[] { return [...idx].flatMap(([k, fs]) => fs.map((f) => `${k}:${f}`)); }
export function _recordModuleEntry(idx: Map<string, string[]>): void { recordQuery("module-entry", [], _entryKeys(idx)); }
registerQueryRerun("module-entry", (repo) => hashSet(_entryKeys(module_entry_index(repo, SKIP_DIRS))));

export async function entry_line(repo: string, relPath: string): Promise<number> {
  if (!available()) return 0;
  let ctx: Ctx | null;
  try { const content = readFileSync(join(repo, relPath), "utf-8"); recordRead(relPath, content); ctx = await makeCtx(content, lang_for(relPath) ?? ""); } catch { return 0; }
  if (!ctx) return 0;
  return entrypoint_line(relPath, ctx);
}

function _call_string_args(ctx: Ctx, call: any): string[] {
  const out: string[] = [];
  for (const s of ctx.collect(call, (k) => k.includes("string") && !k.includes("interpolation"))) {
    const t = ctx.text(s).replace(/^["'`]+|["'`]+$/g, "");
    if (_NAME_RE.test(t) && _MULTISEGMENT.test(t)) out.push(t);
  }
  return out;
}

// Scan calls within [lo,hi] for a distinctive string naming a UNIQUE module entry → RESOLVED_PARTIAL
// edges; two-or-more → ambiguous (a blind spot). Returns [edges, ambiguous].
export function detect(ctx: Ctx, lo: number, hi: number, index: Map<string, string[]>, anchorFile: string): [[string, string, number][], [string, string[]][]] {
  const anchorDir = dirname(anchorFile);
  const edges: [string, string, number][] = [];
  const ambiguous: [string, string[]][] = [];
  const seen = new Set<string>();
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const [s] = ctx.span(call);
    if (s < lo || s > hi) continue;
    for (const name of _call_string_args(ctx, call)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const hits = (index.get(name) ?? []).filter((p) => dirname(p) !== anchorDir);
      if (hits.length === 1) edges.push([name, hits[0], s]);
      else if (hits.length > 1) ambiguous.push([name, hits]);
    }
  }
  return [edges, ambiguous];
}
