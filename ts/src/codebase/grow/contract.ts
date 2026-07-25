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
import { _resolve, _resolve_import, fileImporters } from "../../core/resolve/consumers.js";
import { countUnits } from "../../core/units.js";

// `consumerCount` and `afferent` are FILE-grained — the module graph materialises one consumer node per
// consuming FILE (see scan/module_graph.ts), so both are derived through the shared countUnits contract that
// the renderers use, and the render NAMES the unit. The edge-grained answer for the same relationship is the
// `consumers` shape (grow/project_set.ts), which counts usage SITES. See core/units.ts.
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
    if (cons.length) provides.push({ symbol: m.symbol, kind: m.kind, consumers: cons.sort((a, b) => a.file.localeCompare(b.file)), consumerCount: countUnits(cons).files });
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

  // TYPE-LEVEL exports (`export type|interface|enum X`) are NOT callable defs, so build_footprint doesn't emit them
  // as nodes — they were invisible to the contract, so a dead type export (a real safe-to-narrow signal) was wrongly
  // reported as "0 unused". Enumerate them from source and resolve their consumers via the reverse-import index
  // (fileImporters + parse_imports), scoped to refs that resolve back to THIS module. Interfaces/enums already in
  // `members` (captured as footprint nodes) are skipped to avoid double-counting.
  const memberNames = new Set(members.map((m) => m.symbol));
  const typeExports: { name: string; kind: string }[] = [];
  if (text) {
    const TYPE_RE = /^[ \t]*export[ \t]+(?:declare[ \t]+)?(type|interface|enum)[ \t]+([A-Za-z_$][\w$]*)/gm;
    let tm: RegExpExecArray | null;
    while ((tm = TYPE_RE.exec(text))) if (!memberNames.has(tm[2])) typeExports.push({ kind: tm[1], name: tm[2] });
  }
  if (typeExports.length) {
    const typeNames = new Set(typeExports.map((t) => t.name));
    const importers = [...((await fileImporters(repo)).get(modNorm) ?? [])];
    const importsFromModule = new Map<string, Set<string>>();   // importer file -> names it imports FROM this module
    for (const imp of importers) {
      let itext = ""; try { itext = readFileSync(join(repo, imp), "utf-8"); } catch { continue; }
      const names = new Set<string>();
      for (const ref of parse_imports(imp, itext)) {
        if (!typeNames.has(ref.name)) continue;                 // only resolve refs that could be one of our type exports
        const t = await _resolve_import(repo, imp, ref);
        if (t && normpath(t[0]) === modNorm) names.add(ref.name);
      }
      if (names.size) importsFromModule.set(imp, names);
    }
    for (const te of typeExports) {
      const cons = importers.filter((imp) => importsFromModule.get(imp)?.has(te.name)).map((imp) => ({ file: imp, symbol: te.name }));
      if (cons.length) provides.push({ symbol: te.name, kind: te.kind, consumers: cons.sort((a, b) => a.file.localeCompare(b.file)), consumerCount: countUnits(cons).files });
      else unusedExports.push(te.name);
    }
    provides.sort((a, b) => b.consumerCount - a.consumerCount || a.symbol.localeCompare(b.symbol));
    unusedExports.sort();
  }

  const afferent = countUnits(provides.flatMap((p) => p.consumers.map((c) => ({ file: normpath(c.file), symbol: c.symbol })))).files;
  const efferent = new Set(depends.map((d) => normpath(d.file))).size;

  const contract: ModuleContract = { shape: "contract", module: moduleFile, provides, unusedExports, depends, afferent, efferent };
  if (!provides.length && !unusedExports.length) { contract.noStructure = true; contract.reason = "no-exports"; }
  return contract;
}
