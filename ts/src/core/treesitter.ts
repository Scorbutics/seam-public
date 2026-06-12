// Tree-sitter parsing substrate (web-tree-sitter + prebuilt tree-sitter-wasms grammars). The
// cross-language primitive the headless facts producer uses; mirrors src/core/treesitter.py.
// web-tree-sitter is async-init, so getParser() is async; the rest of the pipeline stays sync by
// pre-computing facts before classify (see facts_treesitter.computeTreeSitterFacts).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// file extension -> tree-sitter grammar name (matches src/core/treesitter.py)
const _LANG_BY_EXT: Record<string, string> = {
  ".py": "python", ".ts": "typescript", ".tsx": "tsx", ".js": "javascript",
  ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".c": "c", ".h": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".kt": "kotlin", ".kts": "kotlin",
  ".go": "go", ".rb": "ruby", ".java": "java", ".cs": "csharp", ".rs": "rust",
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
