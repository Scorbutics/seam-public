// SCAN phase — the DOWN / DEPENDENCY footprint (what a symbol delegates to / how it works): the anchor's
// imports, same-package type refs (Java siblings), DI interface→impl bindings, deterministic string-
// dispatch (tier-2), opt-in LLM coupling (tier-3), and the shared-key overlay. INTERNAL to the phase —
// the public entry is footprint.build_footprint. Port of build_dependency_graph.
import { basename } from "node:path";
import { _resolve_import, _resolve } from "../../core/resolve/consumers.js";
import { parse_imports, SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { normpath } from "../../core/resolve/walk.js";
import { type Ctx, makeCtx, available, lang_for, _TYPE_REF } from "../atoms.js";
import type { EngineCtx } from "../engine_ctx.js";
import {
  type GraphNode, type GraphEdge, type Blindspot, type Provenance, type Unit, type ResolvedGraph, makeGraph,
} from "./graph.js";
import { expanduser, _read, _named_units, _usage_lines } from "./ast_units.js";
import { impls_of } from "./interface_index.js";
import { _annotationLo, _chain_route_consumers } from "./attach.js";

type BuildOpts = {
  anchorLine?: number | null; useLlm?: boolean; model?: string; claudeBin?: string | null;
  dataCoupling?: boolean; dataCouplingLlm?: boolean; ctx?: EngineCtx;
};

// The mutable accumulator every dependency pass shares: the growing graph (nodes/edges/blindspots), the
// node counter + dedup set, the parsed anchor (actx/aunits), and the per-file unit cache addDep populates.
interface DepScan {
  repo: string; anchorFile: string; symbol: string;
  actx: Ctx | null; aunits: Unit[];
  nodes: GraphNode[]; edges: GraphEdge[]; blindspots: Blindspot[];
  counter: number; seen: Set<string>; depUnits: Map<string, Unit[]>; externalPkgs: string[];
}

// Build the anchor (n1) node and its line range. Parses the anchor file to locate the symbol's def
// (kind + span), then narrows to an explicit anchorLine when one is given.
async function _anchorNode(anchorFile: string, symbol: string, ar: [string, string] | null,
    anchorLine: number | null): Promise<{ node: GraphNode; arange: number[] }> {
  let arange = [0, 0], akind = "symbol";
  if (ar && available()) {
    const ctx = await makeCtx(ar[0], ar[1]);
    if (ctx) { const defu = _named_units(ctx).find((u) => u[0] === symbol); if (defu) { akind = defu[1]; arange = [defu[2], defu[3]]; } }
  }
  if (anchorLine != null) arange = [anchorLine, Math.max(anchorLine, arange[1])];
  const node: GraphNode = { id: "n1", symbol, kind: akind, file: anchorFile, range: arange, enclosing: "", complexity: Math.max(1, arange[1] - arange[0] + 1) };
  return { node, arange };
}

// Turn one (referenced symbol → target file) into a dependency node + edge. Shared by the import pass and
// the same-package pass. Skips a target whose symbol is neither a recognised def nor has a line (can't
// place it), and self-references back to the anchor file.
async function _addDep(s: DepScan, refName: string, depFile: string, depLine: number | null,
    edgeKind = "import", provenance: Provenance = "RESOLVED_FULL"): Promise<void> {
  if (s.seen.has(`${refName} ${depFile}`) || normpath(depFile) === normpath(s.anchorFile)) return;
  if (!s.depUnits.has(depFile)) {
    const rd = _read(s.repo, depFile);
    const dctx = rd ? await makeCtx(rd[0], rd[1]) : null;
    s.depUnits.set(depFile, dctx ? _named_units(dctx) : []);
  }
  const defu = s.depUnits.get(depFile)!.find((u) => u[0] === refName);
  let kind: string, rng: number[];
  if (defu) { kind = defu[1]; rng = [defu[2], defu[3]]; }
  else if (depLine != null) { kind = "symbol"; rng = [depLine, depLine]; }
  else return;
  s.seen.add(`${refName} ${depFile}`);
  s.counter += 1;
  const did = `d${s.counter}`;
  s.nodes.push({ id: did, symbol: refName, kind, file: depFile, range: rng, enclosing: "", complexity: Math.max(1, rng[1] - rng[0] + 1) });
  const edge: GraphEdge = { from: "n1", to: did, kind: edgeKind, provenance };
  const call = s.actx ? (_usage_lines(s.actx, s.aunits, refName)[0] ?? null) : null;
  if (call != null) edge.line = call;
  s.edges.push(edge);
}

// 1) IMPORT pass — the symbols the anchor file explicitly imports. Unresolved targets are recorded as
// external packages (→ the external-libraries blindspot).
async function _importPass(s: DepScan, anchorSrc: string): Promise<void> {
  for (const ref of parse_imports(s.anchorFile, anchorSrc)) {
    const target = await _resolve_import(s.repo, s.anchorFile, ref);
    if (target === null || target[0] === null) {
      const ext = ref.source || ref.name;
      if (!s.externalPkgs.includes(ext)) s.externalPkgs.push(ext);
      continue;
    }
    await _addDep(s, ref.name, target[0], target[1]);
  }
}

// 2) SAME-PACKAGE pass — type references the body uses with NO import (Java needs no import for siblings:
// the controller→repository→entity-in-one-package case). Enumerate the type_identifier refs and resolve
// each BARE name via the active resolver — the Java floor maps it to a same-package sibling; import-style
// resolvers (TS/Python) return null for a bare name, so this is a no-op there.
async function _samePackagePass(s: DepScan): Promise<void> {
  if (!s.actx) return;
  const refNames = new Set<string>(s.actx.collect(s.actx.root, (k: string) => _TYPE_REF.has(k)).map((t: any) => s.actx!.text(t)));
  refNames.delete(s.symbol);
  for (const name of [...refNames].sort()) {
    const f = await _resolve(s.repo, s.anchorFile, name);
    if (f) await _addDep(s, name, f, null);
  }
}

// 3) INTERFACE→IMPL pass — extend the footprint PAST a DI interface (@Inject/@Autowired/CDI) to its
// concrete implementation: the runtime binding a static scan can't see, recovered structurally from the
// `implements` relation. SOLE impl → a RESOLVED_PARTIAL `interface-impl` edge (it IS the runtime binding,
// just not statically asserted). MULTIPLE impls → an honest blindspot listing candidates (we don't guess
// which one the container wires). ZERO → left as-is (framework-generated, e.g. a Spring-Data repository:
// a genuine terminal blindspot).
async function _interfaceImplPass(s: DepScan): Promise<void> {
  for (const dn of [...s.nodes]) {
    const cands = await impls_of(s.repo, dn.symbol);
    if (cands.length === 1) await _addDep(s, cands[0].cls, cands[0].file, null, "interface-impl", "RESOLVED_PARTIAL");
    else if (cands.length > 1) s.blindspots.push({ node: dn.symbol, mechanism: "interface-multiple-impls",
      evidence: `${dn.symbol} has ${cands.length} implementations — the runtime DI (CDI/Spring) binding can't be picked statically`, candidates: cands.map((c) => c.cls) });
  }
}

// Summarise the unresolved imports gathered by the import pass into one blindspot.
function _externalLibsBlindspot(s: DepScan): void {
  if (!s.externalPkgs.length) return;
  const shown = s.externalPkgs.slice(0, 8).join(", ") + (s.externalPkgs.length > 8 ? " …" : "");
  s.blindspots.push({ node: "n1", mechanism: "external-libraries",
    evidence: `${s.symbol} uses ${s.externalPkgs.length} external/stdlib dependenc${s.externalPkgs.length === 1 ? "y" : "ies"}: ${shown}`, candidates: [] });
}

// Tier-2 string-dispatch (deterministic): a string literal in the body naming a UNIQUE module entry →
// RESOLVED_PARTIAL; ambiguous → a blind spot. (Tier-3 LLM discovery is gated on use_llm.)
async function _stringDispatchPass(s: DepScan, lo: number, hi: number): Promise<void> {
  if (!s.actx) return;
  try {
    const sc = await import("./string_coupling.js");
    const entryIdx = sc.module_entry_index(s.repo, SKIP_DIRS);
    const [scEdges, scAmbig] = sc.detect(s.actx, lo, hi, entryIdx, s.anchorFile);
    for (const [name, path, line] of scEdges) {
      if (s.seen.has(`${name} ${path}`)) continue;
      s.seen.add(`${name} ${path}`);
      s.counter += 1;
      const did = `d${s.counter}`;
      const entry = await sc.entry_line(s.repo, path);
      s.nodes.push({ id: did, symbol: name, kind: "module", file: path, range: [entry, entry], enclosing: "", complexity: 1 });
      s.edges.push({ from: "n1", to: did, kind: "dispatch", provenance: "RESOLVED_PARTIAL", line });
    }
    for (const [name, hits] of scAmbig) {
      s.blindspots.push({ node: "n1", mechanism: "string-dispatch-ambiguous",
        evidence: `'${name}' names ${hits.length} module entries (ambiguous)`,
        candidates: hits.map((h) => ({ file: h, symbol: name, provenance: "SUGGESTED" })) });
    }
  } catch { /* tree-sitter unavailable → skip tier-2 */ }
}

// Tier-3 LLM discovery (opt-in): residual file couplings the LLM proposes, GROUNDED to real repo paths →
// SUGGESTED blind-spot candidates (never resolved edges).
async function _llmDiscoveryPass(s: DepScan, anchorSrc: string, lo: number, hi: number, opts: BuildOpts): Promise<void> {
  const { discover } = await import("./llm_discovery.js");
  const resolvedFiles = s.nodes.filter((n) => n.id !== "n1").map((n) => n.file);
  for (const c of discover(s.repo, s.anchorFile, anchorSrc, lo, hi, resolvedFiles, { model: opts.model, claudeBin: opts.claudeBin })) {
    s.blindspots.push({ node: "n1", mechanism: "llm-suggested-coupling", evidence: c.evidence,
      candidates: [{ file: c.file, symbol: basename(c.file.split("/").slice(0, -1).join("/")) || c.file, provenance: "SUGGESTED" }] });
  }
}

// Shared-key boundary: keys this anchor produces/consumes ground into boundary nodes + crossing fans
// toward the other side (readers/writers), then route consumers are chained on. (anchor's framework keys
// come from the CACHED key index — _carrier_extra → anchorKeys — not a per-anchor LLM call.)
async function _dataCouplingPass(s: DepScan, anchorSrc: string, arange: number[], opts: BuildOpts): Promise<void> {
  const keyLo = _annotationLo(anchorSrc, arange[0]);   // include a route/entry annotation above the def
  const dc = await import("../coupling/index.js");
  const dcDelta = await dc.resolveCoupling(s.repo, "n1", s.anchorFile, anchorSrc, keyLo, arange[1], s.counter, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, opts.ctx);
  s.nodes.push(...dcDelta.nodes); s.edges.push(...dcDelta.edges); s.blindspots.push(...dcDelta.blindspots); s.counter = dcDelta.counter;
  s.counter = await _chain_route_consumers(s.repo, s.nodes, s.edges, s.counter);
}

export async function build_dependency_graph(repo: string, anchorFile: string, symbol: string,
    opts: BuildOpts = {}): Promise<ResolvedGraph> {
  repo = expanduser(repo);
  const ar = _read(repo, anchorFile);
  const { node: anchor, arange } = await _anchorNode(anchorFile, symbol, ar, opts.anchorLine ?? null);
  const nodes: GraphNode[] = [anchor], edges: GraphEdge[] = [], blindspots: Blindspot[] = [];

  if (ar && available()) {
    const actx = await makeCtx(ar[0], ar[1]);
    const s: DepScan = {
      repo, anchorFile, symbol, actx, aunits: actx ? _named_units(actx) : [],
      nodes, edges, blindspots, counter: 0, seen: new Set(), depUnits: new Map(), externalPkgs: [],
    };
    await _importPass(s, ar[0]);
    await _samePackagePass(s);
    await _interfaceImplPass(s);
    _externalLibsBlindspot(s);
    await _stringDispatchPass(s, arange[0], arange[1]);
    if (opts.useLlm) await _llmDiscoveryPass(s, ar[0], arange[0], arange[1], opts);
    if (opts.dataCoupling !== false) await _dataCouplingPass(s, ar[0], arange, opts);
  }

  return makeGraph({ id: "n1", symbol, file: anchorFile, range: arange }, lang_for(anchorFile) ?? "", nodes, edges, { anchors: ["n1"], blindspots });
}
