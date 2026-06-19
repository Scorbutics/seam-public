// DEF TABLE — enumerate the repo's top-level declarations (and class methods) with enough context to
// EMBED for semantic anchor recall: name + kind + signature line + enclosing class + path. This is the
// closed set the embedding recall ranks against (structure enumerates; the embedder only ranks) — NOT a
// whole-file chunk index. Deterministic, offline; the embed string is built by `embedString`.
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { endsWithSourceExt, provider_for, SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { walk } from "../../core/resolve/walk.js";
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

export interface Def { name: string; kind: string; file: string; signature: string; enclosing: string; doc: string; }

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);

// A declaration on a single line: a class/interface/enum, a function, a const-arrow, or a class METHOD
// (`name(...) {` / `async name(...) {`). Capture groups pick the name; the whole trimmed line is the
// signature. Conservative — misses multi-line signatures (fine; the name+path still embed).
const _CLASS_RE = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?(class|interface|enum|namespace)[ \t]+([A-Za-z_$][\w$]*)/;
const _FN_RE = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)/;
const _ARROW_RE = /^[ \t]*(?:export[ \t]+)?(?:const|let)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)[ \t]*(?::[^\n]+?)?=>/;
const _METHOD_RE = /^[ \t]+(?:public|private|protected|static|async|readonly|get|set|\*|[ \t])*([A-Za-z_$][\w$]*)[ \t]*\([^)]*\)[ \t]*(?::[^={\n]+)?[ \t]*\{/;
const _METHOD_SKIP = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor"]);

// A best-effort enclosing-class tracker by brace depth: a `class X {` owns everything until its brace
// closes. Good enough for embedding signal (it doesn't need to be a parser).
const _DOC_CAP = SCAN.docCap;   // a leading doc-comment carries the CONCEPT the name omits ("inbound load" ←→
// "how many people already want to connect"); the bigger-model A/B showed content, not model size, is
// the recall lever. Capped so the embed string stays compact.
const _isComment = (t: string) => /^(\/\/|\/\*|\*)/.test(t);
const _stripComment = (t: string) => t.replace(/^\/\*+|\*+\/$/g, "").replace(/^\*\s?/, "").replace(/^\/\/\s?/, "").trim();

export function defs_in_file(file: string, text: string): Def[] {
  const out: Def[] = [];
  const stack: { name: string; depth: number }[] = [];
  let depth = 0, pendingDoc = "";
  const take = () => { const d = pendingDoc.trim().slice(0, _DOC_CAP); pendingDoc = ""; return d; };
  for (const raw of text.split("\n")) {
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
      out.push({ name: m[1], kind: "function", file, signature: sig, enclosing, doc: take() });
    } else if ((m = _ARROW_RE.exec(line))) {
      out.push({ name: m[1], kind: "function", file, signature: sig, enclosing, doc: take() });
    } else if (enclosing && (m = _METHOD_RE.exec(line)) && !_METHOD_SKIP.has(m[1])) {
      out.push({ name: m[1], kind: "method", file, signature: sig, enclosing, doc: take() });
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
  return `${prefix}${d.signature || d.name}${encl} — ${d.file}${doc}`;
}

export async function enumerate_defs(repo: string, limit = 4000): Promise<Def[]> {
  repo = expanduser(repo);
  const out: Def[] = [];
  for (const rel of candidate_source_files(repo)) {
    let text: string;
    try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; }
    // PER-LANGUAGE def extraction. The regex extractor (`defs_in_file`) is TS/JS-syntax-specific: it
    // parses TS/JS fine and is the extractor the embed-recall gate was validated with, so KEEP it for
    // TS/JS — no reason to swap a validated path (tree-sitter is more accurate but an unvalidated change
    // for TS embed ranking). For the OTHER languages the regex is near-blind (it found ~1 def across a
    // whole Java repo), so use the language-agnostic tree-sitter extractor there (regex fallback when
    // grammars are absent — the offline .vsix).
    const defs = provider_for(rel)?.name === "typescript"
      ? defs_in_file(rel, text)
      : (await defs_in_file_treesitter(rel, text)) ?? defs_in_file(rel, text);
    for (const d of defs) { out.push(d); if (out.length >= limit) return out; }
  }
  return out;
}
