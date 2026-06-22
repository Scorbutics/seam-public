// PROJECTION — the CUT / CONTRACT shape. The boundary of a module: what crosses IN (other modules that
// depend on its exports) and what crosses OUT (the external modules it depends on). A spine traces a flow
// through a module; this draws the cut-set of resolved edges at the module's edge. grep can't compute a
// boundary and RAG can't verify one — it's the resolved import/consumer edges crossing the file.
//
//   provides      : exported symbols WITH an external consumer (the public surface that's actually used),
//                   each with who uses it — the INBOUND cut.
//   unusedExports : exported but consumed by nobody outside — dead public API (a real, useful signal).
//   depends       : the module's resolved external imports — the OUTBOUND cut.
//   afferent/efferent : fan-in / fan-out (distinct external files) — the classic coupling/stability pair.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build_footprint } from "../scan/index.js";
import { normpath } from "../../core/resolve/walk.js";
import { parse_imports, namespace_imports } from "../../core/resolve/languages/index.js";
import { _resolve, _resolve_import } from "../../core/resolve/consumers.js";

export interface ProvidedSymbol { symbol: string; kind: string; consumers: { file: string; symbol: string }[]; consumerCount: number }
export interface ExternalDep { symbol: string; source: string; file: string }

export interface ModuleContract {
  shape: "contract";
  module: string;
  provides: ProvidedSymbol[];      // inbound cut: used exports + their external consumers
  unusedExports: string[];         // exported, no external consumer (dead public API)
  depends: ExternalDep[];          // outbound cut: resolved external imports
  afferent: number;                // fan-in: distinct external files depending on this module
  efferent: number;                // fan-out: distinct external files this module depends on
  noStructure?: boolean;           // no exported members → no contract to describe
  reason?: "no-exports";
}

export async function projectContract(repo: string, moduleFile: string, opts: { model?: string; claudeBin?: string | null } = {}): Promise<ModuleContract> {
  // PROVIDES — reuse the module footprint (exported members + their cross-file consumers). dataCoupling
  // off: the contract is the call/import cut, not the data-flow overlay.
  const g = await build_footprint(repo, moduleFile, null, { dataCoupling: false, model: opts.model, claudeBin: opts.claudeBin });
  const modNorm = normpath(moduleFile);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const members = g.nodes.filter((n) => n.id !== "mod" && normpath(n.file) === modNorm);
  const consumersOf = new Map<string, { file: string; symbol: string }[]>();
  for (const e of g.edges) {
    const from = byId.get(e.from);
    if (!from || normpath(from.file) === modNorm) continue;   // only edges crossing IN from another file
    (consumersOf.get(e.to) ?? consumersOf.set(e.to, []).get(e.to)!).push({ file: from.file, symbol: from.symbol });
  }

  const provides: ProvidedSymbol[] = [];
  const unusedExports: string[] = [];
  for (const m of members) {
    const cons = consumersOf.get(m.id) ?? [];
    if (cons.length) provides.push({ symbol: m.symbol, kind: m.kind, consumers: cons.sort((a, b) => a.file.localeCompare(b.file)), consumerCount: cons.length });
    else unusedExports.push(m.symbol);
  }
  provides.sort((a, b) => b.consumerCount - a.consumerCount || a.symbol.localeCompare(b.symbol));
  unusedExports.sort();

  // DEPENDS — the module's resolved external imports (named + namespace), deduped, excluding self.
  const depends: ExternalDep[] = [];
  const seen = new Set<string>();
  let text = "";
  try { text = readFileSync(join(repo, moduleFile), "utf-8"); } catch { /* leave empty */ }
  if (text) {
    for (const ref of parse_imports(moduleFile, text)) {
      const t = await _resolve_import(repo, moduleFile, ref);
      const f = t?.[0];
      if (!f || normpath(f) === modNorm) continue;
      const k = `${ref.name}@${normpath(f)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      depends.push({ symbol: ref.name, source: ref.source ?? "", file: f });
    }
    for (const ns of namespace_imports(moduleFile, text)) {
      const f = await _resolve(repo, moduleFile, ns.source);
      if (!f || normpath(f) === modNorm) continue;
      const k = `*${ns.local}@${normpath(f)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      depends.push({ symbol: `* as ${ns.local}`, source: ns.source, file: f });
    }
  }
  depends.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));

  const afferent = new Set(provides.flatMap((p) => p.consumers.map((c) => normpath(c.file)))).size;
  const efferent = new Set(depends.map((d) => normpath(d.file))).size;

  const contract: ModuleContract = { shape: "contract", module: moduleFile, provides, unusedExports, depends, afferent, efferent };
  if (!members.length) { contract.noStructure = true; contract.reason = "no-exports"; }
  return contract;
}
