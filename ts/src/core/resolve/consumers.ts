// Port of src/core/resolve/consumers.py (the resolver-injection seam + _resolve_import). The
// graph-building machinery stays in codebase mode; this is the thin cone diff-mode (blast radius)
// + facts_resolve share. A consumer is RESOLVED_FULL only when the import's module path resolves to the
// anchor file; a name match whose module doesn't resolve is a SUGGESTED blind spot (the same one
// resolution ladder as call-graph dispatch + graph edges — core/resolution).
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import type { Provenance } from "../resolution.js";
import type { ImportRef, NamespaceImport, DefaultImport } from "./languages/base.js";
import { floor_resolve, endsWithSourceExt, parse_imports, namespace_imports, default_imports, SKIP_DIRS } from "./languages/index.js";
import { normpath, walkFiles } from "./walk.js";

// A resolver: resolve_module(repo, importingFile, source) → repo-relative file | null, and
// optionally resolve_symbol(repo, importingFile, line, col) → [file, line] | null (LSP). ASYNC —
// a real language server is reached over a socket/subprocess (Node I/O is async). The deterministic
// floor is sync; the async interface awaits trivially over it.
export interface Resolver {
  resolve_module(repo: string, importingFile: string, source: string): Promise<string | null>;
  resolve_symbol?(repo: string, importingFile: string, line: number, col: number): Promise<[string, number] | null>;
}

let _ACTIVE_RESOLVER: Resolver | null = null;
export function set_resolver(r: Resolver | null): void { _ACTIVE_RESOLVER = r; }
export function get_resolver(): Resolver | null { return _ACTIVE_RESOLVER; }

// A MODULE source → repo-relative file: the active resolver (LSP when installed via set_resolver),
// else the per-language deterministic floor. ASYNC — the active resolver is a language server reached
// over async I/O; the floor awaits trivially. Mirrors Python's single `_resolve` (its blocking I/O is
// sync for free; ours is async). Used by BOTH diff (blast_radius, facts_resolve) and codebase scan.
export async function _resolve(repo: string, importingFile: string, source: string): Promise<string | null> {
  if (_ACTIVE_RESOLVER) return _ACTIVE_RESOLVER.resolve_module(repo, importingFile, source);
  return floor_resolve(repo, importingFile, source);
}

// An ImportRef → [repo-relative target file, def line | null], or null. A source-string import (TS)
// resolves the MODULE path; a source-less import (Python) resolves the SYMBOL via LSP go-to-definition.
export async function _resolve_import(repo: string, importingFile: string, ref: ImportRef): Promise<[string | null, number | null] | null> {
  if (ref.source !== null) {
    const f = await _resolve(repo, importingFile, ref.source);
    return f ? [f, null] : null;
  }
  if (_ACTIVE_RESOLVER?.resolve_symbol) return _ACTIVE_RESOLVER.resolve_symbol(repo, importingFile, ref.line, ref.col);
  return null;
}

// A consumer in a test file is VERIFICATION (the `test` role). Mirrors resolver.ts TEST_PATH.
const _TEST_RE = /(\.(test|spec)\.[a-z]+$)|((^|\/)(tests?|__tests__|spec)\/)/i;
export function _kind_for(file: string, kind: string): string {
  return _TEST_RE.test(file.replace(/\\/g, "/")) ? "test" : kind;
}

const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

export interface Consumer { file: string; local: string; source: string; status: Provenance; reexport?: boolean; }

// Repo-wide parsed-imports index, built ONCE per repo and reused by every consumer scan. Each
// scan_consumers otherwise re-walks + re-reads + re-PARSES every file in the repo, and the grow calls it
// repeatedly (per frontier node AND per route-caller in _chain_route_consumers, per step) — which
// dominates a large-repo grow (measured: ~6s/build, 36s of a 52s run on a real repo). Content-static per
// run + process-scoped, so memoising is safe (same rationale as the tree-sitter parse cache).
type ImportEntry = { rel: string; norm: string; refs: ImportRef[]; ns: NamespaceImport[]; defs: DefaultImport[]; text: string };
const _repoImportsCache = new Map<string, ImportEntry[]>();
export function resetRepoImports(): void { _repoImportsCache.clear(); }
function _repoImports(repo: string): ImportEntry[] {
  let idx = _repoImportsCache.get(repo);
  if (idx) return idx;
  idx = [];
  for (const { rel, abs, text } of walkFiles(repo, SKIP_DIRS, endsWithSourceExt)) {
    // `text` is cached so the namespace member-access scan can check `X.symbol` without a re-read; the
    // walk already read it, so this trades memory for avoiding a second pass over the repo.
    idx.push({ rel, norm: normpath(abs), refs: parse_imports(rel, text), ns: namespace_imports(rel, text), defs: default_imports(rel, text), text });
  }
  _repoImportsCache.set(repo, idx);
  return idx;
}

// Is `symbol` the DEFAULT export of `anchorFile`? — `export default symbol`, `export default
// function/class symbol`, or `export { symbol as default }`. Default imports bind the module's default
// under an arbitrary name, so we only treat them (and `default as` re-exports) as consumers when this
// holds — recall-safe (no over-matching unrelated default imports). Anonymous `export default () => …`
// has no symbol name, so it never matches (its importers are unattributable without a name anyway).
function _isDefaultExport(repo: string, anchorFile: string, symbol: string): boolean {
  let text: string;
  try { text = readFileSync(join(repo, anchorFile), "utf-8"); } catch { return false; }
  const s = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`export\\s+default\\s+(?:async\\s+)?(?:function|class)?\\s*${s}\\b`).test(text)
    || new RegExp(`export\\s*\\{[^}]*\\b${s}\\s+as\\s+default\\b`).test(text);
}

// A namespace-member consumer: file F binds a module under `local` and uses `local.symbol`. Matches a
// CALL `X.symbol(` as RESOLVED_FULL (a proven call) and a bare reference `X.symbol` as RESOLVED_PARTIAL
// (a value/passed reference — a followable lead). `local` is the namespace binding (e.g. `scan`).
function _member_use(text: string, local: string, symbol: string): Provenance | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${esc(local)}\\s*\\.\\s*${esc(symbol)}\\s*\\(`).test(text)) return "RESOLVED_FULL";
  if (new RegExp(`\\b${esc(local)}\\s*\\.\\s*${esc(symbol)}\\b`).test(text)) return "RESOLVED_PARTIAL";
  return null;
}

// [consumer_file, {member → local}] for files whose import of one or more `memberNames` resolves to
// `anchorFile` — member co-occurrence for module mode. Reads the cached import index (no re-walk).
export async function scan_module_consumers(repo: string, anchorFile: string, memberNames: Set<string>): Promise<[string, Record<string, string>][]> {
  const anchorNorm = normpath(anchorFile);
  const anchorAbs = normpath(join(repo, anchorFile));
  const out: [string, Record<string, string>][] = [];
  for (const { rel, norm, refs } of _repoImports(repo)) {
    if (norm === anchorAbs) continue;
    const used: Record<string, string> = {};
    for (const ref of refs) {
      if (!memberNames.has(ref.name)) continue;
      const target = await _resolve_import(repo, rel, ref);
      if (target === null || target[0] === null || normpath(target[0]) !== anchorNorm) continue;
      if (!(ref.name in used)) used[ref.name] = ref.local;
    }
    if (Object.keys(used).length) out.push([rel, used]);
  }
  return out;
}

// One repo walk → files importing `symbol` whose module resolves to `anchorFile` (resolved) or whose
// basename matches (suggested). `reexport` is carried so the transitive closure can follow barrels.
async function _scan_direct(repo: string, anchorFile: string, symbol: string): Promise<Consumer[]> {
  const anchorNorm = normpath(anchorFile);
  const anchorBase = stem(anchorFile);
  const anchorAbs = normpath(join(repo, anchorFile));
  const isDefault = _isDefaultExport(repo, anchorFile, symbol);   // gate default-import matching (recall-safe)
  const out: Consumer[] = [];
  for (const { rel, norm, refs, ns, defs, text } of _repoImports(repo)) {   // cached index — no per-call repo walk/parse
    if (norm === anchorAbs) continue;
    for (const ref of refs) {
      if (ref.name !== symbol) continue;
      const target = await _resolve_import(repo, rel, ref);
      if (target !== null) {
        if (target[0] !== null && normpath(target[0]) === anchorNorm) out.push({ file: rel, local: ref.local, source: ref.source || "", status: "RESOLVED_FULL", reexport: ref.reexport });
      } else if (ref.source && ref.source.replace(/\/+$/, "").split("/").pop() === anchorBase) {
        out.push({ file: rel, local: ref.local, source: ref.source, status: "SUGGESTED", reexport: ref.reexport });
      }
      break;
    }
    // Namespace-member consumers: `const X = await import("…anchor module…")` then `X.symbol(...)`. The
    // module must resolve to the anchor (so when scan_consumers recurses into a re-export barrel, a
    // namespace import of THAT barrel — e.g. `scan.build_footprint` against `scan/index.ts` — is caught).
    // `local: symbol` lets the downstream usage-line scan find `X.symbol` by name, like a named import.
    for (const n of ns) {
      const t = await _resolve(repo, rel, n.source);
      if (!t || normpath(t) !== anchorNorm) continue;
      const status = _member_use(text, n.local, symbol);
      if (status) { out.push({ file: rel, local: symbol, source: n.source, status }); break; }
    }
    // DEFAULT-export consumers (only when `symbol` IS the anchor's default export — matched by MODULE, not
    // name, since the binding is the importer's choice). Two forms: a `default as Name` re-export barrel
    // (followed transitively under Name), and a direct `import Name from "anchor"` (Name = the local used).
    if (isDefault) {
      for (const ref of refs) {
        if (ref.name !== "default" || !ref.reexport) continue;
        const t = await _resolve_import(repo, rel, ref);
        if (t?.[0] && normpath(t[0]) === anchorNorm) { out.push({ file: rel, local: ref.local, source: ref.source || "", status: "RESOLVED_FULL", reexport: true }); break; }
      }
      for (const d of defs) {
        const t = await _resolve(repo, rel, d.source);
        if (t && normpath(t) === anchorNorm) { out.push({ file: rel, local: d.local, source: d.source, status: "RESOLVED_FULL" }); break; }
      }
    }
  }
  return out;
}

const _REEXPORT_HOP_CAP = 5;   // runaway guard on barrel chains (a → barrel → barrel → …)

// Files importing `symbol`, classified resolved vs suggested — TRANSITIVELY THROUGH BARRELS. A consumer
// that RE-EXPORTS the symbol (`export { X } from anchor`) is a barrel, not a real user: keep searching for
// the symbol (under its outward name) imported FROM that barrel, transitively, so the real users of a
// barrel-wired symbol resolve to the anchor instead of dead-ending at the barrel. Re-export hops are
// transparent (they don't count toward the caller's depth) — only a visited-set + hop cap bound the walk.
export async function scan_consumers(repo: string, anchorFile: string, symbol: string,
    _visited?: Set<string>, _hop = 0): Promise<Consumer[]> {
  const visited = _visited ?? new Set<string>();
  const key = `${normpath(anchorFile)}::${symbol}`;
  if (visited.has(key) || _hop > _REEXPORT_HOP_CAP) return [];
  visited.add(key);
  const out: Consumer[] = [];
  for (const c of await _scan_direct(repo, anchorFile, symbol)) {
    out.push(c);   // the barrel/importer file is itself part of the wiring chain
    if (c.reexport && c.status === "RESOLVED_FULL") {
      for (const t of await scan_consumers(repo, c.file, c.local, visited, _hop + 1)) out.push(t);
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => { const k = `${c.file}::${c.local}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
