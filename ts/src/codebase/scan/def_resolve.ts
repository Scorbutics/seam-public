// SCAN phase — resolve a NAME used in a file to the file that DEFINES it, following the deterministic
// resolution graph: same-file def → a NAMED import / re-export barrel hop → a DEFAULT import (→ the
// module's default export). Deps-free (tree-sitter + the deterministic module resolver + the source's own
// `export`s), depth-capped against import cycles.
// Extracted from scan/down/dependency_graph.ts (where it resolved a TYPE name) so the UP passes can reuse
// the SAME hop ladder for a FUNCTION name — one mechanism, one set of hops, per CLAUDE.md.
import { _resolve_import } from "../../core/resolve/consumers.js";
import { parse_imports, default_imports } from "../../core/resolve/languages/index.js";
import { makeCtx } from "../atoms.js";
import { normpath } from "../../core/resolve/walk.js";
import { _read, _named_units } from "../ast_units.js";

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

// Is the bare NAME `name`, as used in `file`, PROVABLY bound to a symbol that lives somewhere ELSE?
// An import declaration creates the file's module-scope binding for that name, so a bare `name(...)` there is
// the IMPORT — not a same-named METHOD of a class declared in the same file (a method is not a module binding,
// so the two can coexist and mean different things). Same hop ladder as `resolveDefFile`, so there is ONE
// import-resolution mechanism (and languages with no import parser — Ruby/C/C++ — simply return false).
// PROOF-ONLY, never a guess: returns false (⇒ the caller keeps its existing behaviour) when the module does not
// resolve, and when the ladder resolves the name back to `file` itself (a self re-export barrel).
export async function importBindsElsewhere(repo: string, file: string, text: string, name: string): Promise<boolean> {
  const targets: Array<[string, string]> = [];   // [target file, the name to look for THERE]
  for (const ref of parse_imports(file, text)) {
    if (ref.local !== name || ref.reexport) continue;   // `export { X } from '…'` is a barrel hop, not a local binding
    const t = await _resolve_import(repo, file, ref);
    if (t && t[0]) targets.push([t[0], ref.name]);
  }
  for (const di of default_imports(file, text)) {
    if (di.local !== name) continue;
    const t = await _resolve_import(repo, file, { name: di.local, local: di.local, source: di.source, line: di.line ?? 0, col: 0 });
    if (t && t[0]) targets.push([t[0], di.local]);
  }
  for (const [tf, tn] of targets) {
    if (normpath(tf) === normpath(file)) continue;                     // the import resolves to THIS file — not "elsewhere"
    const d = await resolveDefFile(repo, tf, tn, DEF_FUNC_KINDS);
    if (d && normpath(d) === normpath(file)) continue;                 // a re-export ring back to us — unprovable, keep it
    return true;
  }
  return false;
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
