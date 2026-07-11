// Tree-sitter parsing substrate (web-tree-sitter + prebuilt tree-sitter-wasms grammars). The
// cross-language primitive the headless facts producer uses; mirrors src/core/treesitter.py.
// web-tree-sitter is async-init, so getParser() is async; the rest of the pipeline stays sync by
// pre-computing facts before classify (see facts_treesitter.computeTreeSitterFacts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// file extension -> tree-sitter grammar name (matches src/core/treesitter.py). NOT derived
// programmatically from the LanguageProvider registry (core/resolve/languages/index.ts): a provider's
// extensions can split across MULTIPLE grammars (TS's `.ts`/`.mts`/`.cts` are the "typescript" grammar but
// its `.tsx` is a separate "tsx" grammar; `.h` is ambiguously "cpp" here even though C owns `.c`), so the
// mapping is genuinely per-extension, not per-provider. Every extension the registry's SOURCE_EXTS lists IS
// expected to have an entry here (enforced by test/core/treesitter_lang_coverage.test.ts) — go/cs/rs are
// grammar-only extras with no registered LanguageProvider yet, kept only for tree-sitter's own reach.
const _LANG_BY_EXT: Record<string, string> = {
  ".py": "python", ".pyi": "python", ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".c": "c", ".h": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".kt": "kotlin", ".kts": "kotlin",
  ".go": "go", ".rb": "ruby", ".rake": "ruby", ".java": "java", ".cs": "csharp", ".rs": "rust",
};
// grammar name -> tree-sitter-wasms file stem (only csharp differs).
const _WASM_NAME: Record<string, string> = { csharp: "c_sharp" };

// Grammar pack location. When the engine is bundled into the VS Code extension (esbuild → a single
// CJS file), `import.meta.url` points at the bundle, not this source, so the relative path breaks.
// The extension copies the wasm pack next to the bundle and passes its absolute path via
// SEAM_WASM_DIR. Falling back to the source-relative path keeps `bun` dev runs working unchanged.
const _ENV_WASM_DIR = process.env.SEAM_WASM_DIR;
const WASM_DIR = _ENV_WASM_DIR
  ? (_ENV_WASM_DIR.endsWith("/") ? _ENV_WASM_DIR : _ENV_WASM_DIR + "/")
  : fileURLToPath(new URL("../../node_modules/tree-sitter-wasms/out/", import.meta.url));

export function langForExt(ext: string): string | null { return _LANG_BY_EXT[ext.toLowerCase()] ?? null; }

// Languages that share ONE runtime/link unit, so an in-process call in one CAN structurally invoke a
// symbol DEFINED in another: JS/TS/TSX transpile to the same JS runtime; Java/Kotlin share the JVM;
// C/C++ share the linker. A call site in a DIFFERENT family can only reach the anchor across a BOUNDARY
// (HTTP / FFI / JNI) — which is the coupling overlay's job, NEVER the structural call-site pass. A
// language absent here is its own singleton family (python / ruby / go / …). Sourced from the language
// registry above (the same closed set `_LANG_BY_EXT` enumerates), not a parallel hardcoded list.
const _LANG_FAMILY: Record<string, string> = {
  javascript: "js", typescript: "js", tsx: "js",
  java: "jvm", kotlin: "jvm",
  c: "native", cpp: "native",
};
export function langFamily(lang: string): string { return _LANG_FAMILY[lang] ?? lang; }
// Two languages can host an in-process call between them. Null (unknown ext) is never same-family — an
// unparseable candidate is not a provable structural consumer.
export function sameLangFamily(a: string | null, b: string | null): boolean {
  return a != null && b != null && langFamily(a) === langFamily(b);
}

// Generic node helpers (language-agnostic): a field accessor and a typed-descendant collector. Every
// language front-end walks tree-sitter ASTs the same way, so these live in the shared substrate rather
// than being re-declared per language. `collectByType` recurses through matched nodes too (a `call`
// nested in another `call` yields both).
export const field = (n: any, f: string): any => n?.childForFieldName?.(f) ?? null;
export function collectByType(node: any, type: string, out: any[] = []): any[] {
  if (node.type === type) out.push(node);
  for (let i = 0; i < node.namedChildCount; i++) collectByType(node.namedChild(i), type, out);
  return out;
}

// Repo-wide parsed-AST cache, keyed by (grammar, repo, file) — shared by every language's carrier
// tracer (each otherwise re-read + re-parsed the same files across hops). Content-static per run +
// process-scoped, so memoising is safe. `resetParseCache` is the test/CI hook (a real re-run is a
// fresh process; tests simulate that).
// Caches the TREE (not just rootNode) so resetParseCache can FREE the WASM memory — web-tree-sitter trees
// are not GC'd, so an un-freed cache on a big repo (thousands of files) exhausts the WASM heap → an
// out-of-bounds crash. A long-lived process (MCP) calls resetParseCache between grows to release it.
const _astCache = new Map<string, any>();
export function resetParseCache(): void { for (const t of _astCache.values()) t?.delete?.(); _astCache.clear(); }
export async function parseFile(repo: string, file: string, grammar: string): Promise<any | null> {
  const key = `${grammar}\0${repo}\0${file}`;
  if (_astCache.has(key)) return _astCache.get(key)?.rootNode ?? null;
  const parser = await getParser(grammar);
  let tree: any = null;
  if (parser) { try { tree = parser.parse(readFileSync(join(repo, file), "utf-8")); } catch { tree = null; } }
  _astCache.set(key, tree);
  return tree?.rootNode ?? null;
}

export function isCommentOrString(kind: string): boolean {
  return kind.includes("comment") || kind.includes("string") || kind.includes("char_literal");
}

export function available(): boolean {
  return existsSync(WASM_DIR) && existsSync(`${WASM_DIR}tree-sitter-python.wasm`);
}

let _inited = false;
const _parsers = new Map<string, any>();

export async function getParser(grammar: string): Promise<any | null> {
  const { Parser, Language } = await import("web-tree-sitter");
  if (!_inited) { await Parser.init(); _inited = true; }
  if (_parsers.has(grammar)) return _parsers.get(grammar);
  const stem = _WASM_NAME[grammar] ?? grammar;
  const wasm = `${WASM_DIR}tree-sitter-${stem}.wasm`;
  if (!existsSync(wasm)) { _parsers.set(grammar, null); return null; }
  try {
    const lang = await Language.load(wasm);
    const p = new Parser();
    p.setLanguage(lang);
    _parsers.set(grammar, p);
    return p;
  } catch {
    _parsers.set(grammar, null);
    return null;
  }
}
