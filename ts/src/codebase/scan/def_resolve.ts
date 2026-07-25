// SCAN phase — resolve a NAME used in a file to the file that DEFINES it, following the deterministic
// resolution graph: same-file def → a NAMED import / re-export barrel hop → a DEFAULT import (→ the
// module's default export). Deps-free (tree-sitter + the deterministic module resolver + the source's own
// `export`s), depth-capped against import cycles.
// Extracted from scan/down/dependency_graph.ts (where it resolved a TYPE name) so the UP passes can reuse
// the SAME hop ladder for a FUNCTION name — one mechanism, one set of hops, per CLAUDE.md.
import { _resolve_import } from "../../core/resolve/consumers.js";
import { parse_imports, default_imports } from "../../core/resolve/languages/index.js";
import { makeCtx } from "../atoms.js";
import { _read, _named_units } from "./ast_units.js";

// The unit KINDS `_named_units` emits; a caller says which ones count as "the definition" it is after.
// (`_named_units` labels every `_CLASS_KINDS` node — incl. interfaces/enums — "class".)
export const DEF_TYPE_KINDS = new Set(["class", "interface"]);
export const DEF_FUNC_KINDS = new Set(["function", "method"]);

export async function resolveDefFile(repo: string, fromFile: string, name: string,
    kinds: Set<string> = DEF_TYPE_KINDS, depth = 0): Promise<string | null> {
  if (depth > 6) return null;
  const rd = _read(repo, fromFile); if (!rd) return null;
  const ctx = await makeCtx(rd[0], rd[1]); if (!ctx) return null;
  if (_named_units(ctx).some((u) => u[0] === name && kinds.has(u[1]))) return fromFile;   // defined here
  for (const ref of parse_imports(fromFile, rd[0])) if (ref.local === name || ref.name === name) {   // named import / re-export
    const t = await _resolve_import(repo, fromFile, ref);
    if (t && t[0]) { const d = await resolveDefFile(repo, t[0], ref.name, kinds, depth + 1); if (d) return d; }
  }
  for (const di of default_imports(fromFile, rd[0])) if (di.local === name) {   // `import name from "m"` → m's DEFAULT export
    const t = await _resolve_import(repo, fromFile, { name: di.local, local: di.local, source: di.source, line: di.line ?? 0, col: 0 });
    if (t && t[0]) { const d = await _resolveDefaultExportDef(repo, t[0], kinds, depth + 1); if (d) return d; }
  }
  return null;
}

// The file that DEFINES a module's DEFAULT export: `export default class X {}` (here) / `export default X` /
// `export { X as default }` (→ resolve the NAME X, which may itself be a named import from `./client`).
async function _resolveDefaultExportDef(repo: string, moduleFile: string, kinds: Set<string>, depth: number): Promise<string | null> {
  if (depth > 6) return null;
  const rd = _read(repo, moduleFile); if (!rd) return null;
  const text = rd[0];
  if (/export\s+default\s+(?:async\s+)?(?:function|class)\s+[A-Za-z_$][\w$]*/.test(text)) return moduleFile;   // default def is HERE
  const m = text.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/) ?? text.match(/export\s*\{[^}]*\b([A-Za-z_$][\w$]*)\s+as\s+default\b/);
  return m ? resolveDefFile(repo, moduleFile, m[1], kinds, depth + 1) : null;
}
