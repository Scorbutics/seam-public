// DI-BINDING INDEX — the repo-level orchestration (walk + per-file cache + memo) around the language-specific
// binding GRAMMAR. The split exists for the layering rule (architecture.test.ts): the ioctopus/TS grammar lives in
// languages/typescript/di_bindings.ts and stays free of codebase/ imports, while the scanning infrastructure it
// needs — tree-sitter ctx construction, the incremental per-file cache, the repo walk — lives here in codebase/,
// which may depend downward on languages/. Adding another language's DI grammar = another entry in GRAMMARS.
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import { recordQuery, registerQueryRerun, hashSet } from "../../core/resolve/dep_recorder.js";
import { walk } from "../../core/resolve/walk.js";
import { makeCtx, available, lang_for } from "../atoms.js";
import { _read } from "../ast_units.js";
import { incrementalScanAsync, indexCacheEnabled } from "../../core/resolve/index_cache.js";
import { DI_MARKERS, scanDiBindings, bare, type DiBinding, type DiContribution } from "../../languages/typescript/di_bindings.js";
import { relative, join } from "node:path";

export type { DiBinding } from "../../languages/typescript/di_bindings.js";

// Build the tree-sitter ctx, then hand it to the language grammar. The textual pre-gate short-circuits the parse for
// the overwhelming majority of files that contain no binding token at all.
async function _scanDiFile(rel: string, text: string): Promise<DiContribution> {
  if (!DI_MARKERS.some((m) => text.includes(m))) return { bindings: [] };
  const grammar = lang_for(rel);
  if (!grammar) return { bindings: [] };
  const ctx = await makeCtx(text, grammar);
  if (!ctx) return { bindings: [] };
  return scanDiBindings(rel, ctx);
}

interface DiIndex { byToken: Map<string, DiBinding>; byClass: Map<string, DiBinding> }
const _cache = new Map<string, DiIndex>();  // per-process memo (disk cache self-invalidates per file)

async function buildIndex(repo: string): Promise<DiIndex> {
  const hit = _cache.get(repo);
  if (hit) return hit;
  const byToken = new Map<string, DiBinding>();
  const byClass = new Map<string, DiBinding>();
  const absorb = (bs: DiBinding[]) => { for (const b of bs) {
    if (!byToken.has(b.token)) byToken.set(b.token, b);
    for (const c of b.impls) if (!byClass.has(c)) byClass.set(c, b);
  } };
  if (!available()) { const idx = { byToken, byClass }; _cache.set(repo, idx); return idx; }  // no tree-sitter → empty
  if (indexCacheEnabled()) {
    // per-FILE cached scan: a DI-module edit re-parses only that file (mtime/size keyed) — edit-safe for MCP-resident.
    for (const { data } of await incrementalScanAsync(repo, SKIP_DIRS, endsWithSourceExt, "di-v1", _scanDiFile, "di-bindings"))
      absorb(data.bindings);
  } else {
    for (const [dir, files] of walk(repo, SKIP_DIRS)) for (const fn of files) {
      if (!endsWithSourceExt(fn)) continue;
      const rel = relative(repo, join(dir, fn)).replace(/\\/g, "/");
      const rd = _read(repo, rel);
      if (rd) absorb((await _scanDiFile(rel, rd[0])).bindings);
    }
  }
  const idx = { byToken, byClass };
  _cache.set(repo, idx);
  return idx;
}

// The DI binding that PRODUCES class `cls` (an interface-impl member) — so a deps answer can attach how that
// concrete impl is wired to its token + the runtime condition. null when the class isn't container-bound.
export async function diBindingForClass(repo: string, cls: string): Promise<DiBinding | null> {
  const b = (await buildIndex(repo)).byClass.get(cls) ?? null;
  recordQuery("di-binding", [cls], b ? [`${b.token}|${b.kind}|${b.file}:${b.line}`] : []);
  return b;
}
registerQueryRerun("di-binding", async (repo, [cls]) => {
  const b = (await buildIndex(repo)).byClass.get(cls) ?? null;
  return hashSet(b ? [`${b.token}|${b.kind}|${b.file}:${b.line}`] : []);
});

// The DI binding registered under a bare token name (e.g. "REDIS_CLIENT") — used to resolve a toClass dep map.
export async function diBindingForToken(repo: string, token: string): Promise<DiBinding | null> {
  return (await buildIndex(repo)).byToken.get(bare(token)) ?? null;
}

// Test/CLI hook: drop the per-repo memo so a fresh run (or an edited fixture) rebuilds.
export function _resetDiIndex(): void { _cache.clear(); }
