import * as vscode from "vscode";
import * as path from "path";

// --- the VS Code AST facts producer ------------------------------------------------
// Contributes the facts the editor's language server gives RELIABLY and cross-language:
// `defines` (symbols a hunk defines) and `enclosing` (the symbol it edits inside), read
// from DocumentSymbols. The engine's `MergedFactsProvider` overlays these on a base
// producer (tree-sitter/regex) that fills decisions/calls/etc. So this is a PARTIAL
// payload — we only claim the fields we can resolve well, and leave the rest to the base.
//
// The contract is keyed by the engine's hunk ids (from the TS CLI `--emit-hunks`), so the
// ids always match. Equivalence with the tree-sitter producer is checked on the engine's
// side (assert_providers_equivalent); here we just emit the payload.

interface HunkSkel { id: string; file: string; start: number; end: number; }
export interface PartialFacts {
  version: number;
  partial: true;
  fields: string[];
  hunks: Record<string, { defines: string[]; enclosing: string[] }>;
}

// A DocumentSymbol flattened with the names of its ancestors (its enclosing chain).
interface FlatSym { name: string; defLine: number; from: number; to: number; parents: string[]; }

function flatten(syms: vscode.DocumentSymbol[], parents: string[], out: FlatSym[]): void {
  for (const s of syms) {
    out.push({
      name: s.name,
      defLine: s.selectionRange.start.line,
      from: s.range.start.line,
      to: s.range.end.line,
      parents,
    });
    if (s.children && s.children.length) flatten(s.children, [...parents, s.name], out);
  }
}

async function documentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[] | undefined> {
  try {
    const res = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
      "vscode.executeDocumentSymbolProvider", uri);
    if (!res || !res.length) return undefined;
    // Only the hierarchical DocumentSymbol form carries selectionRange/children we need;
    // a provider returning flat SymbolInformation is skipped (its facts stay the base's).
    if ((res[0] as vscode.DocumentSymbol).selectionRange) return res as vscode.DocumentSymbol[];
    return undefined;
  } catch {
    return undefined;
  }
}

// Build the partial facts payload for the given hunks (grouped by file → one symbol query
// per file). Best-effort: a file with no language server / no symbols contributes nothing
// and the engine's base provider fills it — no error, just graceful degradation.
export async function computeSymbolFacts(repoRoot: string, hunks: HunkSkel[]): Promise<PartialFacts> {
  const out: PartialFacts = { version: 1, partial: true, fields: ["defines", "enclosing"], hunks: {} };
  const byFile = new Map<string, HunkSkel[]>();
  for (const h of hunks) {
    const l = byFile.get(h.file) ?? [];
    l.push(h);
    byFile.set(h.file, l);
  }
  for (const [file, hs] of byFile) {
    const uri = vscode.Uri.file(path.join(repoRoot, file));
    const syms = await documentSymbols(uri);
    if (!syms) continue;
    const flat: FlatSym[] = [];
    flatten(syms, [], flat);
    for (const h of hs) {
      const lo = h.start - 1, hi = h.end - 1;            // 0-based inclusive new-side range
      const defines = new Set<string>();
      const enclosing = new Set<string>();
      for (const s of flat) {
        if (s.defLine >= lo && s.defLine <= hi) defines.add(s.name);   // defined within the hunk
        if (s.from <= lo && s.to >= hi) {                              // spans the hunk → encloses it
          enclosing.add(s.name);
          for (const p of s.parents) enclosing.add(p);
        }
      }
      if (defines.size || enclosing.size)
        out.hunks[h.id] = { defines: [...defines], enclosing: [...enclosing] };
    }
  }
  return out;
}
