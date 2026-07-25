// SCAN phase — ADDRESS VALIDATION for `<file>#<symbol>`: is the symbol actually DECLARED in the file the
// caller addressed? This is the counterpart of the CLI's "--center path not found under --repo" guard, one
// level deeper: the path exists, but the NAME doesn't live there.
//
// Why it is a guard and not a result: every footprint builder resolves the anchor by looking the symbol up in
// the anchor file's units and, when it isn't there, falls back to a bare `kind: "symbol"` node at :0 and asks
// the resolver who imports THAT name FROM THAT FILE. Nobody does, so the answer renders as an authoritative
// `resolved: 0` + "Nothing in the repo calls this symbol — an entry point, dead code, or dispatched-only".
// Telling a caller their live code is dead is the worst failure the engine has (same class as the tree-sitter
// outage guarded by requireAvailable), and here it is TRIGGERED BY A ROUTINE MISTAKE: a DEFAULT export is
// bound by importers under a name of their own choosing, so the name every call site shows (and every grep
// finds) is NOT a symbol of the defining file. cal.com's handleCancelBooking.ts is exactly that — no such
// declaration, `export default handler` at :766, five importers calling it `handleCancelBooking`.
//
// The distinction this draws is DECLARED-BUT-UNUSED (a true, useful empty answer — still reported) vs
// NOT-DECLARED-AT-ALL (an addressing error). Deduced from grounded structure only: the file's own bindings.
import { makeCtx, available } from "../atoms.js";
import { _read, _named_units, _exported_members, _declared_names, _default_export_local } from "./ast_units.js";

export type AnchorAddress = {
  declared: boolean;            // the file binds/declares this name somewhere
  defaultExportLocal: string | null;   // the local symbol behind `export default` (the usual missing piece)
  candidates: string[];         // addressable symbols, public surface first
};

// Resolve how `symbol` is addressable in `anchorFile`. Returns null when the file cannot be READ or PARSED
// (unknown language, missing grammar, parse failure) — absence of evidence is not evidence of a bad address,
// so the caller must degrade to today's behaviour rather than error.
export async function resolve_anchor_address(repo: string, anchorFile: string, symbol: string): Promise<AnchorAddress | null> {
  if (!available()) return null;
  const ar = _read(repo, anchorFile);
  if (!ar) return null;
  const ctx = await makeCtx(ar[0], ar[1]);
  if (!ctx) return null;
  const declared = _declared_names(ctx, anchorFile);
  // Candidate ORDER = what an outside caller can actually address: the module's public surface first (that is
  // what the importers of this file see), then the file's other named defs. Deduped, order-stable.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const nm of [..._exported_members(ctx, anchorFile).map((m) => m[0]), ..._named_units(ctx).map((u) => u[0])])
    if (nm && nm !== "default" && !seen.has(nm)) { seen.add(nm); candidates.push(nm); }
  return { declared: declared.has(symbol), defaultExportLocal: _default_export_local(ctx), candidates };
}
