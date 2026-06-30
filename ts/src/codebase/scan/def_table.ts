// DEF TABLE — enumerate the repo's top-level declarations (and class methods) with enough context to
// EMBED for semantic anchor recall: name + kind + signature line + enclosing class + path. This is the
// closed set the embedding recall ranks against (structure enumerates; the embedder only ranks) — NOT a
// whole-file chunk index. Deterministic, offline; the embed string is built by `embedString`.
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { endsWithSourceExt, provider_for, SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { walk, normpath } from "../../core/resolve/walk.js";
import { incrementalScanFiles, indexCacheEnabled } from "../../core/resolve/index_cache.js";
import { defs_in_file_treesitter } from "./def_treesitter.js";
import { SCAN } from "./config.js";

// Anchor candidates come from HAND-WRITTEN source. A source file past this size is almost always a
// vendored/minified/generated bundle (e.g. a checked-in JS library under webapp/resources, a generated
// client) — never a module you'd anchor an INTENT on, and parsing/embedding it dominates recall cost.
// Skipping it from the candidate table is language-agnostic and only affects RECALL (a large real file
// is still resolvable as an import target). Adjustable; 128 KB clears typical hand-written modules.
const _MAX_CANDIDATE_BYTES = 128 * 1024;

// Shared by every anchor-candidate enumerator (def table + lexical name floor) so a vendored bundle is
// excluded from ALL recall paths, not just one. Missing/unstattable → treat as skip.
export function oversizedForAnchor(abs: string): boolean {
  try { return statSync(abs).size > _MAX_CANDIDATE_BYTES; } catch { return true; }
}

// git's view of non-ignored files (tracked + untracked-but-not-ignored), repo-relative, NUL-separated.
// Lets git do the .gitignore matching (nested/global/negation rules) instead of us re-implementing it.
// null ⇒ not a git repo / git unavailable → caller falls back to the SKIP_DIRS walk.
function _git_files(repo: string): string[] | null {
  const r = spawnSync("git", ["-C", repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.split("\0").filter(Boolean);
}

// The repo's anchor-CANDIDATE source files, layered most-principled-first:
//   1. respect .gitignore (via git) — excludes build outputs / deps / generated code the repo itself
//      declares junk, rather than guessing with a hardcoded skip list (non-git trees fall back to it);
//   2. still drop well-known vendored dir names even when COMMITTED (vendor/, node_modules/, …);
//   3. drop oversized vendored/minified bundles (committed libs git tracks, e.g. a checked-in leaflet).
// Deterministic (sorted) regardless of source. Repo-relative, forward-slash paths.
export function candidate_source_files(repo: string): string[] {
  repo = expanduser(repo);
  let rels = _git_files(repo);
  if (rels === null) {
    rels = [];
    for (const [dir, files] of walk(repo, SKIP_DIRS))
      for (const fn of files) rels.push(relative(repo, join(dir, fn)).replace(/\\/g, "/"));
  }
  const out = rels.filter((rel) =>
    endsWithSourceExt(rel)
    && !rel.split("/").some((seg) => SKIP_DIRS.has(seg))
    && !oversizedForAnchor(join(repo, rel)));
  out.sort();
  return out;
}

export interface Def { name: string; kind: string; file: string; signature: string; enclosing: string; doc: string; body?: string; }

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);

// A declaration on a single line: a class/interface/enum, a function, a const-arrow, or a class METHOD
// (`name(...) {` / `async name(...) {`). Capture groups pick the name; the whole trimmed line is the
// signature. Conservative — misses multi-line signatures (fine; the name+path still embed).
const _CLASS_RE = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?(class|interface|enum|namespace)[ \t]+([A-Za-z_$][\w$]*)/;
const _FN_RE = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)/;
const _ARROW_RE = /^[ \t]*(?:export[ \t]+)?(?:const|let)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*(?::[^\n]+?)?=>/;
const _METHOD_RE = /^[ \t]+(?:public|private|protected|static|async|readonly|get|set|\*|[ \t])*([A-Za-z_$][\w$]*)[ \t]*\([^)]*\)[ \t]*(?::[^={\n]+)?[ \t]*\{/;
const _METHOD_SKIP = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor"]);
// DECLARATIVE ENDPOINT-MAP entry — `"createBooking": { endpoint: baseUrl, method: 'post' }`. A config-driven
// API client lists its OPERATIONS as object KEYS whose value is a route descriptor, not as functions — so the
// fn/method patterns miss them and the screen is invisible to anchor recall. The value carrying BOTH a route
// key (endpoint/url/path/route) AND a verb key (method/verb) is the structural signature of an operation.
const _ENDPOINT_MAP_RE = /^[ \t]*["']?([A-Za-z_$][\w$]*)["']?[ \t]*:[ \t]*\{[^}]*\b(?:endpoint|url|path|route)\b[^}]*\b(?:method|verb)\b/i;
// OBJECT-LITERAL ASSIGNMENT that opens a block — `Vue.prototype.bookingService = {`, `module.exports = {`,
// `const svc = {`. Its shorthand methods (`async createBooking(vm, …) {`) are real defs, but they only get
// extracted when an enclosing scope is on the stack — a class does that, a plain object literal did NOT, so a
// service object's methods were invisible. Treating the assignment as an enclosing scope fixes it (its name is
// the last identifier before `= {`; brace-depth pops it like a class). The config-key map (handled above) is
// also `= {` but its entries are `key: {…}`, not `name(…) {`, so the method pattern still won't false-fire.
const _OBJ_OPEN_RE = /(?:^|[ \t.])([A-Za-z_$][\w$]*)[ \t]*=[ \t]*\{[ \t]*$/;

// A best-effort enclosing-class tracker by brace depth: a `class X {` owns everything until its brace
// closes. Good enough for embedding signal (it doesn't need to be a parser).
const _DOC_CAP = SCAN.docCap;   // a leading doc-comment carries the CONCEPT the name omits ("inbound load" ←→
// "how many people already want to connect"); the bigger-model A/B showed content, not model size, is
// the recall lever. Capped so the embed string stays compact.
const _isComment = (t: string) => /^(\/\/|\/\*|\*)/.test(t);
const _stripComment = (t: string) => t.replace(/^\/\*+|\*+\/$/g, "").replace(/^\*\s?/, "").replace(/^\/\/\s?/, "").trim();

// The BODY passage = the next `bodyLines` code lines after a callable's signature (the calls/identifiers
// that say what it DOES — the concept the signature+doc omit), comment-stripped + whitespace-collapsed,
// capped. A forward window, not a brace-matched body: cheap, and the head of a body carries the salient
// calls. Callables only (a container's "body" is its member list — noise for relevance).
export function _body_window(lines: string[], from: number): string {
  const parts: string[] = [];
  for (let i = from + 1; i < lines.length && i <= from + SCAN.bodyLines; i++) {
    const t = lines[i].trim();
    if (!t || _isComment(t) || /^[{}()[\];,]+$/.test(t)) continue;   // skip blank / comment / brace-only lines
    parts.push(t);
    if (parts.join(" ").length >= SCAN.bodyCap) break;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, SCAN.bodyCap);
}

export function defs_in_file(file: string, text: string): Def[] {
  const out: Def[] = [];
  const stack: { name: string; depth: number }[] = [];
  let depth = 0, pendingDoc = "";
  const take = () => { const d = pendingDoc.trim().slice(0, _DOC_CAP); pendingDoc = ""; return d; };
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.length > 300 ? raw.slice(0, 300) : raw;
    const trimmed = line.trim();
    if (_isComment(trimmed)) { if (pendingDoc.length < _DOC_CAP) pendingDoc += " " + _stripComment(trimmed); continue; }
    const enclosing = stack.length ? stack[stack.length - 1].name : "";
    const sig = trimmed.replace(/[ \t]*\{[ \t]*$/, "");
    let m: RegExpMatchArray | null;
    if ((m = _CLASS_RE.exec(line))) {
      out.push({ name: m[2], kind: m[1], file, signature: sig, enclosing, doc: take() });
      if (/\{/.test(line)) stack.push({ name: m[2], depth });
    } else if ((m = _FN_RE.exec(line))) {
      out.push({ name: m[1], kind: "function", file, signature: sig, enclosing, doc: take(), body: _body_window(lines, li) });
    } else if ((m = _ARROW_RE.exec(line))) {
      out.push({ name: m[1], kind: "function", file, signature: sig, enclosing, doc: take(), body: _body_window(lines, li) });
    } else if (enclosing && (m = _METHOD_RE.exec(line)) && !_METHOD_SKIP.has(m[1])) {
      out.push({ name: m[1], kind: "method", file, signature: sig, enclosing, doc: take(), body: _body_window(lines, li) });
    } else if ((m = _ENDPOINT_MAP_RE.exec(line))) {
      // a declarative API operation (object key → { endpoint, method }) — anchorable like a function.
      out.push({ name: m[1], kind: "function", file, signature: sig, enclosing, doc: take(), body: _body_window(lines, li) });
    } else if ((m = _OBJ_OPEN_RE.exec(line))) {
      // an object literal assigned to a name → an enclosing scope, so its shorthand methods are extracted.
      if (/\{/.test(line)) stack.push({ name: m[1], depth });
    } else if (trimmed) { pendingDoc = ""; }   // a non-comment, non-decl code line breaks the doc run
    for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") { depth--; if (stack.length && depth <= stack[stack.length - 1].depth) stack.pop(); } }
  }
  return out;
}

// The string fed to the embedder — carries the domain signal the bare NAME lacks (the spike: adding the
// signature + enclosing class moved a generic `save` from #5 to #3 on a fuzzy intent).
export function embedString(d: Def): string {
  const encl = d.enclosing ? ` in ${d.enclosing}` : "";
  // a method's signature has no leading keyword, so tag it; class/function/const already carry theirs.
  const prefix = d.kind === "method" ? "method " : "";
  const doc = d.doc ? ` :: ${d.doc}` : "";   // the concept the name omits — the recall lever
  const body = d.body ? ` { ${d.body} }` : "";   // the passage AROUND the symbol — the calls/identifiers that say what it does
  return `${prefix}${d.signature || d.name}${encl} — ${d.file}${doc}${body}`;
}

// `files` (repo-relative, normpath-matched) scopes extraction to just those files — the footprint-local
// embedding path (intent-relevance ranking) only needs its own seams' defs, not a whole-repo tree-sitter
// walk. The emitted `Def.file` stays the canonical rel (we FILTER candidate_source_files, not iterate the
// raw set), so cache keys match the unscoped recall pass and warm entries are reused.
// A FILE-LEVEL def so a source file is recallable by its IDENTITY even when it declares no top-level named
// symbol the extractors catch — a `module.exports = {…}` / `export default {…}` / Vue-plugin / config /
// route file whose meaning lives in the FILENAME + leading doc + path, not in a class/function name (the
// reported miss: a `bookingService.js` Vue plugin whose only extracted def was a nested `transformResultError`
// arrow, so the booking flow's entry was never a candidate). Name = basename; doc = the first comment block;
// body = the file head. kind "module" so the CLI grows it FILE-LEVEL (build_module_graph) when chosen.
export function module_def(rel: string, text: string): Def {
  const base = (rel.split("/").pop() ?? rel).replace(/\.[^.]+$/, "");
  const lines = text.split("\n");
  let doc = "";
  for (let i = 0; i < Math.min(lines.length, 40) && doc.length < _DOC_CAP; i++) {
    const t = lines[i].trim();
    if (_isComment(t)) doc += " " + _stripComment(t);
    else if (doc) break;   // first contiguous comment block ended
  }
  return { name: base, kind: "module", file: rel, signature: `module ${base}`, enclosing: "", doc: doc.trim().slice(0, _DOC_CAP), body: _body_window(lines, -1) };
}

// PER-LANGUAGE def extraction for ONE file → its real defs + the file-level module def. The regex extractor
// (`defs_in_file`) is TS/JS-syntax-specific: it parses TS/JS fine and is the extractor the embed-recall gate
// was validated with, so KEEP it for TS/JS — no reason to swap a validated path (tree-sitter is more accurate
// but an unvalidated change for TS embed ranking). For the OTHER languages the regex is near-blind (it found
// ~1 def across a whole Java repo), so use the language-agnostic tree-sitter extractor there (regex fallback
// when grammars are absent — the offline .vsix). The module def is cheap (string ops, no parse) so it's
// always computed and cached; whether it's emitted is the assembler's `moduleDefs` decision.
async function _scan_defs_file(rel: string, text: string): Promise<{ defs: Def[]; mod: Def }> {
  const defs = provider_for(rel)?.name === "typescript"
    ? defs_in_file(rel, text)
    : (await defs_in_file_treesitter(rel, text)) ?? defs_in_file(rel, text);
  return { defs, mod: module_def(rel, text) };
}
// Bump on any change to the per-file def EXTRACTION (defs_in_file / defs_in_file_treesitter / module_def)
// so the on-disk cache is invalidated rather than serving stale-shaped defs.
const _DEF_TABLE_SALT = "def-v1";

// WHOLE-REPO def table — assemble the candidate defs (disk-cached per file, so warm re-runs re-parse only the
// CHANGED files). Returns up to `limit` in candidate order.
async function _enumerateWholeRepo(repo: string, limit: number, moduleDefs: boolean): Promise<Def[]> {
  const out: Def[] = [];
  if (indexCacheEnabled()) {
    for (const { data } of await incrementalScanFiles(repo, candidate_source_files(repo), _DEF_TABLE_SALT, _scan_defs_file, "def-table")) {
      for (const d of data.defs) { out.push(d); if (out.length >= limit) return out; }
      if (moduleDefs) { out.push(data.mod); if (out.length >= limit) return out; }
    }
    return out;
  }
  for (const rel of candidate_source_files(repo)) {
    let text: string;
    try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; }
    const { defs, mod } = await _scan_defs_file(rel, text);
    for (const d of defs) { out.push(d); if (out.length >= limit) return out; }
    if (moduleDefs) { out.push(mod); if (out.length >= limit) return out; }   // file-level def AFTER the real ones
  }
  return out;
}

// IN-MEMORY memo of the whole-repo table — it's re-enumerated SEVERAL times per grow (anchor recall, intent
// rank, and the grow's own embed pass) and even WARM each call re-runs `git ls-files` + stats every candidate
// file + reloads/assembles the disk cache (~hundreds of ms on a big repo — the "scanning several times" symptom).
// The table is STABLE within a process (files don't change mid-grow), so memo it per (repo, limit, moduleDefs).
// `_resetDefTableMem()` clears it for a process that edits files between enumerations (the incremental test).
const _defTableMem = new Map<string, Def[]>();
export function _resetDefTableMem(): void { _defTableMem.clear(); }

export async function enumerate_defs(repo: string, limit = 4000, files?: Set<string>, opts: { moduleDefs?: boolean } = {}): Promise<Def[]> {
  repo = expanduser(repo);
  const want = files && files.size ? new Set([...files].map(normpath)) : null;
  if (!want) {   // WHOLE-REPO recall (no `files` scope) — memoised: re-enumerated several times per grow, stable per process
    const key = `${repo}|${limit}|${!!opts.moduleDefs}`;
    const hit = _defTableMem.get(key);
    if (hit) return hit;
    const out = await _enumerateWholeRepo(repo, limit, !!opts.moduleDefs);
    _defTableMem.set(key, out);
    return out;
  }
  // SCOPED (`files`) recall — already bounded (a few footprint files); a direct read, not memoised.
  const out: Def[] = [];
  for (const rel of candidate_source_files(repo)) {
    if (!want.has(normpath(rel))) continue;
    let text: string;
    try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; }
    const { defs, mod } = await _scan_defs_file(rel, text);
    for (const d of defs) { out.push(d); if (out.length >= limit) return out; }
    if (opts.moduleDefs) { out.push(mod); if (out.length >= limit) return out; }
  }
  return out;
}
