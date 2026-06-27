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
import { incrementalScan, indexCacheEnabled } from "./index_cache.js";

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
// MEMOIZED (deterministic-floor path only): a module resolution is pure for a given (file, source), but the
// batched/transitive consumer scan resolves the SAME refs many times (per barrel hop, per ns/default loop).
// Cleared by resetRepoImports (alongside the import index). The LSP-resolver path isn't cached (it owns state).
const _resolveCache = new Map<string, string | null>();
export async function _resolve(repo: string, importingFile: string, source: string): Promise<string | null> {
  if (_ACTIVE_RESOLVER) return _ACTIVE_RESOLVER.resolve_module(repo, importingFile, source);
  // KEY by repo too — a resolution is per-(repo, file, source). Without the repo, two repos with the same
  // RELATIVE file + import (common across test fixtures) collide in this process-global memo.
  const k = `${repo}\0${importingFile}\0${source}`;
  let hit = _resolveCache.get(k);
  if (hit === undefined) { hit = floor_resolve(repo, importingFile, source); _resolveCache.set(k, hit); }
  return hit;
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
export function isTestFile(file: string): boolean { return _TEST_RE.test(file.replace(/\\/g, "/")); }
export function _kind_for(file: string, kind: string): string {
  return isTestFile(file) ? "test" : kind;
}

const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

export interface Consumer { file: string; local: string; source: string; status: Provenance; reexport?: boolean; }

// Repo-wide parsed-imports index, built ONCE per repo and reused by every consumer scan. Each
// scan_consumers otherwise re-walks + re-reads + re-PARSES every file in the repo, and the grow calls it
// repeatedly (per frontier node AND per route-caller in _chain_route_consumers, per step) — which
// dominates a large-repo grow (measured: ~6s/build, 36s of a 52s run on a real repo). Content-static per
// run + process-scoped, so memoising is safe (same rationale as the tree-sitter parse cache).
// Each file's PARSED imports — the JSON-serializable contribution persisted by the incremental cache. `text`
// is deliberately NOT stored (it would bloat the cache with every file's full contents); the few namespace/
// default-export consumers re-read it lazily in _scan_direct (`textOf`).
type ImportContribution = { refs: ImportRef[]; ns: NamespaceImport[]; defs: DefaultImport[] };
type ImportEntry = ImportContribution & { rel: string; norm: string };
const _repoImportsCache = new Map<string, ImportEntry[]>();
export function resetRepoImports(): void { _repoImportsCache.clear(); _resolveCache.clear(); }

// The repo-wide reverse-import index — built ONCE per process AND persisted to `.seam/import-index.json`
// (content-keyed by mtime/size). Finding consumers is a REVERSE-dependency query (a consumer lives anywhere),
// so it inherently needs this whole-repo index — but it was rebuilt every PROCESS (in-mem only), parsing
// imports of every file each cold run. Now a re-run re-parses ONLY changed files (the same incrementalScan
// pattern as the floor + DI index). `SEAM_INDEX_CACHE=0` falls back to the plain walk.
function _repoImports(repo: string): ImportEntry[] {
  let idx = _repoImportsCache.get(repo);
  if (idx) return idx;
  const build = (rel: string, text: string): ImportContribution => ({ refs: parse_imports(rel, text), ns: namespace_imports(rel, text), defs: default_imports(rel, text) });
  if (indexCacheEnabled()) {
    idx = incrementalScan(repo, SKIP_DIRS, endsWithSourceExt, "import-v1", build, "import-index")
      .map(({ rel, data }) => ({ rel, norm: normpath(join(repo, rel)), ...data }));
  } else {
    idx = [];
    for (const { rel, abs, text } of walkFiles(repo, SKIP_DIRS, endsWithSourceExt)) idx.push({ rel, norm: normpath(abs), ...build(rel, text) });
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
  for (const { rel, norm, refs, ns, defs } of _repoImports(repo)) {   // cached index — no per-call repo walk/parse
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
    if (ns.length) {                                          // text is needed ONLY for the namespace member scan → read it lazily (most files have no ns)
      let text = ""; try { text = readFileSync(join(repo, rel), "utf-8"); } catch { /* unreadable → skip ns */ }
      for (const n of ns) {
        const t = await _resolve(repo, rel, n.source);
        if (!t || normpath(t) !== anchorNorm) continue;
        const status = _member_use(text, n.local, symbol);
        if (status) { out.push({ file: rel, local: symbol, source: n.source, status }); break; }
      }
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

// ── BATCHED consumer scan ──────────────────────────────────────────────────────────────────────────
// scan_consumers iterates the WHOLE import index per symbol — so N changed symbols re-walk the same index N
// times (the redundancy the review-impact budget capped). scan_consumers_batch resolves the consumers of a
// SET of (file, symbol) anchors in ONE index pass: cost is O(index once + actual consumers), independent of
// the symbol count, so the bridge can analyse EVERY changed symbol with no cap. Semantics are identical to
// running scan_consumers per anchor (named / namespace-member / default-export, transitive through reexport
// barrels) — pinned by an equivalence test.

const _akey = (repo: string, file: string, symbol: string) => `${normpath(file)}::${symbol}`;

type _Target = { file: string; symbol: string; norm: string; abs: string; base: string; isDefault: boolean; key: string };
function _push<V>(m: Map<string, V[]>, k: string, v: V): void { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }

// ONE pass over the import index → each target's DIRECT consumers (no barrel recursion; that's the wrapper's).
async function _scan_direct_multi(repo: string, targets: { file: string; symbol: string }[]): Promise<Map<string, Consumer[]>> {
  const out = new Map<string, Consumer[]>();
  const ts: _Target[] = [];
  const byName = new Map<string, _Target[]>(), byNorm = new Map<string, _Target[]>(), defaultByNorm = new Map<string, _Target[]>();
  for (const t of targets) {
    const key = _akey(repo, t.file, t.symbol);
    if (out.has(key)) continue;                                   // dedupe identical targets
    const tt: _Target = { file: t.file, symbol: t.symbol, norm: normpath(t.file), abs: normpath(join(repo, t.file)), base: stem(t.file), isDefault: _isDefaultExport(repo, t.file, t.symbol), key };
    ts.push(tt); out.set(key, []);
    _push(byName, tt.symbol, tt); _push(byNorm, tt.norm, tt);
    if (tt.isDefault) _push(defaultByNorm, tt.norm, tt);
  }
  if (!ts.length) return out;
  const anyDefault = defaultByNorm.size > 0;

  for (const { rel, norm, refs, ns, defs } of _repoImports(repo)) {
    // NAMED imports
    for (const ref of refs) {
      const matches = byName.get(ref.name);
      if (!matches) continue;
      const target = await _resolve_import(repo, rel, ref);
      const resolved = target && target[0] ? normpath(target[0]) : null;
      for (const t of matches) {
        if (norm === t.abs) continue;
        if (resolved !== null) { if (resolved === t.norm) _push(out, t.key, { file: rel, local: ref.local, source: ref.source || "", status: "RESOLVED_FULL", reexport: ref.reexport }); }
        else if (target === null && ref.source && ref.source.replace(/\/+$/, "").split("/").pop() === t.base) _push(out, t.key, { file: rel, local: ref.local, source: ref.source, status: "SUGGESTED", reexport: ref.reexport });
      }
    }
    // NAMESPACE-member consumers (X.symbol) — resolve each ns source once, match against targets by module
    if (ns.length && byNorm.size) {
      let text: string | null = null;
      for (const n of ns) {
        const tt = await _resolve(repo, rel, n.source);
        if (!tt) continue;
        const matches = byNorm.get(normpath(tt));
        if (!matches) continue;
        if (text === null) { try { text = readFileSync(join(repo, rel), "utf-8"); } catch { text = ""; } }
        for (const t of matches) { if (norm === t.abs) continue; const status = _member_use(text, n.local, t.symbol); if (status) _push(out, t.key, { file: rel, local: t.symbol, source: n.source, status }); }
      }
    }
    // DEFAULT-export consumers — only for targets whose symbol IS their file's default export
    if (anyDefault) {
      for (const ref of refs) {
        if (ref.name !== "default" || !ref.reexport) continue;
        const target = await _resolve_import(repo, rel, ref);
        if (!target?.[0]) continue;
        for (const t of defaultByNorm.get(normpath(target[0])) ?? []) if (norm !== t.abs) _push(out, t.key, { file: rel, local: ref.local, source: ref.source || "", status: "RESOLVED_FULL", reexport: true });
      }
      for (const d of defs) {
        const tt = await _resolve(repo, rel, d.source);
        if (!tt) continue;
        for (const t of defaultByNorm.get(normpath(tt)) ?? []) if (norm !== t.abs) _push(out, t.key, { file: rel, local: d.local, source: d.source, status: "RESOLVED_FULL" });
      }
    }
  }
  return out;
}

// Consumers of each anchor, TRANSITIVELY through reexport barrels — one index pass per hop (not per symbol).
export async function scan_consumers_batch(repo: string, anchors: { file: string; symbol: string }[]): Promise<Map<string, Consumer[]>> {
  const result = new Map<string, Consumer[]>();
  for (const a of anchors) result.set(_akey(repo, a.file, a.symbol), []);
  // each frontier item descends from an ORIGIN anchor; barrel-transitive consumers attribute to that origin.
  let frontier = anchors.map((a) => ({ file: a.file, symbol: a.symbol, origin: _akey(repo, a.file, a.symbol) }));
  const visited = new Set<string>();
  for (let hop = 0; hop <= _REEXPORT_HOP_CAP && frontier.length; hop++) {
    const todo = frontier.filter((it) => { const k = `${_akey(repo, it.file, it.symbol)}|${it.origin}`; if (visited.has(k)) return false; visited.add(k); return true; });
    if (!todo.length) break;
    // unique (file,symbol) targets this hop; map each back to the origins waiting on it
    const originsByTarget = new Map<string, Set<string>>();
    for (const it of todo) _push2(originsByTarget, _akey(repo, it.file, it.symbol), it.origin);
    const byTarget = await _scan_direct_multi(repo, todo.map((it) => ({ file: it.file, symbol: it.symbol })));
    const next: typeof frontier = [];
    for (const [tkey, cons] of byTarget) {
      const origins = originsByTarget.get(tkey) ?? new Set();
      for (const c of cons) {
        for (const origin of origins) result.get(origin)!.push(c);
        if (c.reexport && c.status === "RESOLVED_FULL") for (const origin of origins) next.push({ file: c.file, symbol: c.local, origin });
      }
    }
    frontier = next;
  }
  for (const [k, cons] of result) {   // dedupe per origin, mirroring scan_consumers
    const seen = new Set<string>();
    result.set(k, cons.filter((c) => { const ck = `${c.file}::${c.local}`; if (seen.has(ck)) return false; seen.add(ck); return true; }));
  }
  return result;
}
function _push2(m: Map<string, Set<string>>, k: string, v: string): void { const s = m.get(k); if (s) s.add(v); else m.set(k, new Set([v])); }
