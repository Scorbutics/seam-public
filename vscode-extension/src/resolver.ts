import * as vscode from "vscode";
import * as path from "path";

// =============================================================================
// SymbolResolver — Layer 1, the verified skeleton (plan §1/§4).
//
// This module is the codebase product's DETERMINISTIC backbone and the ONE place
// the VSCode language API is touched. Decision D1/§4: resolution is sub-contracted
// to the editor's language servers (tsserver, Pylance, rust-analyzer, …) via the
// `vscode.execute*` commands. The rest of the system (the Python layers 3-6) never
// sees `vscode` — it consumes only the `ResolvedGraph` JSON this file emits. Keep it
// that way: nothing here may import decomposition logic, and nothing there may import
// this. The JSON contract IS the abstraction boundary (constraint §4).
//
// THE CARRYING INVARIANT (plan §1): every edge here is RESOLVED — it comes from a real
// symbol-resolution query, not a guess. The LLM never runs in this file. And
// `UNKNOWN ≠ []`: a resolver query that cannot be answered returns `unknown(reason)`,
// recorded in `ResolvedGraph.unresolved`, NEVER silently flattened to "no edge". That
// distinction is what stops the map from lying with confidence (a false isolated-core).
// =============================================================================

// A resolver answer is EITHER a value OR an explicit "I don't know" — never an empty
// list standing in for ignorance. This tagged union is `UNKNOWN ≠ []` in the type.
export type ResolverResult<T> =
  | { kind: "resolved"; value: T }
  | { kind: "unknown"; reason: string };

const resolved = <T>(value: T): ResolverResult<T> => ({ kind: "resolved", value });
const unknown = (reason: string): ResolverResult<never> => ({ kind: "unknown", reason });

export type ResolutionQuality = "FULL" | "PARTIAL" | "HEURISTIC" | "NONE";

// The resolver surface the BFS needs. VSCodeSymbolResolver is the first implementation;
// a StackGraphsResolver / LspDirectResolver (standalone/CI) could implement the same
// interface without touching the BFS or the Python layers (plan §4).
export interface SymbolResolver {
  documentSymbols(uri: vscode.Uri): Promise<ResolverResult<vscode.DocumentSymbol[]>>;
  prepareCallHierarchy(uri: vscode.Uri, pos: vscode.Position): Promise<ResolverResult<vscode.CallHierarchyItem[]>>;
  outgoingCalls(item: vscode.CallHierarchyItem): Promise<ResolverResult<vscode.CallHierarchyOutgoingCall[]>>;
  incomingCalls(item: vscode.CallHierarchyItem): Promise<ResolverResult<vscode.CallHierarchyIncomingCall[]>>;
  getDefinition(uri: vscode.Uri, pos: vscode.Position): Promise<ResolverResult<(vscode.Location | vscode.LocationLink)[]>>;
  references(uri: vscode.Uri, pos: vscode.Position): Promise<ResolverResult<vscode.Location[]>>;
  // Probe (plan §4) — fire a known-shape query at the anchor and classify the server's
  // real quality, never assume it from a static per-language table.
  resolutionQuality(uri: vscode.Uri, pos: vscode.Position): Promise<ResolutionQuality>;
}

// Each method maps to one editor command and converts "threw / null / empty" into the
// HONEST distinction: a genuine empty result stays `resolved([])`; a failure that means
// "couldn't answer" (no provider, indexing not finished) becomes `unknown(reason)`.
export class VSCodeSymbolResolver implements SymbolResolver {
  async documentSymbols(uri: vscode.Uri): Promise<ResolverResult<vscode.DocumentSymbol[]>> {
    try {
      const res = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
        "vscode.executeDocumentSymbolProvider", uri);
      if (!res) return unknown("no_symbol_provider");
      if (!res.length) return resolved([]);
      // Only the hierarchical DocumentSymbol form carries the ranges/children we need.
      if ((res[0] as vscode.DocumentSymbol).selectionRange) return resolved(res as vscode.DocumentSymbol[]);
      return unknown("flat_symbols_only");
    } catch {
      return unknown("symbol_provider_threw");
    }
  }

  async prepareCallHierarchy(uri: vscode.Uri, pos: vscode.Position): Promise<ResolverResult<vscode.CallHierarchyItem[]>> {
    try {
      const res = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        "vscode.prepareCallHierarchy", uri, pos);
      if (!res) return unknown("no_call_hierarchy_provider");
      return resolved(res);
    } catch {
      return unknown("call_hierarchy_threw");
    }
  }

  async outgoingCalls(item: vscode.CallHierarchyItem): Promise<ResolverResult<vscode.CallHierarchyOutgoingCall[]>> {
    try {
      const res = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        "vscode.provideOutgoingCalls", item);
      return res ? resolved(res) : unknown("no_outgoing_calls");
    } catch {
      return unknown("outgoing_calls_threw");
    }
  }

  async incomingCalls(item: vscode.CallHierarchyItem): Promise<ResolverResult<vscode.CallHierarchyIncomingCall[]>> {
    try {
      const res = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        "vscode.provideIncomingCalls", item);
      return res ? resolved(res) : unknown("no_incoming_calls");
    } catch {
      return unknown("incoming_calls_threw");
    }
  }

  async getDefinition(uri: vscode.Uri, pos: vscode.Position): Promise<ResolverResult<(vscode.Location | vscode.LocationLink)[]>> {
    try {
      const res = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider", uri, pos);
      if (!res) return unknown("no_definition_provider");
      return resolved(res);
    } catch {
      return unknown("definition_threw");
    }
  }

  async references(uri: vscode.Uri, pos: vscode.Position): Promise<ResolverResult<vscode.Location[]>> {
    try {
      const res = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider", uri, pos);
      if (!res) return unknown("no_reference_provider");
      return resolved(res);
    } catch {
      return unknown("reference_provider_threw");
    }
  }

  async resolutionQuality(uri: vscode.Uri, pos: vscode.Position): Promise<ResolutionQuality> {
    // Probe, don't assume (plan §4). The usage map rests on find-references (the ground truth
    // of links, plan §4): symbols present + references resolve ⇒ FULL; symbols but the
    // reference provider can't answer ⇒ HEURISTIC; nothing ⇒ NONE.
    const docs = await this.documentSymbols(uri);
    if (docs.kind === "unknown") return "NONE";
    const refs = await this.references(uri, pos);
    return refs.kind === "resolved" ? "FULL" : "HEURISTIC";
  }
}

// =============================================================================
// ResolvedGraph — the JSON contract this front emits (plan §2.1). Plain data, no
// `vscode` types: this is exactly what `graph_ir.from_resolved_graph` ingests.
// =============================================================================
export interface RGNode {
  id: string; symbol: string; kind: string; file: string;
  range: [number, number]; enclosing: string; complexity: number;
}
export interface RGEdge { from: string; to: string; kind: string; provenance: string; }
export interface ResolvedGraph {
  version: number;
  anchor: { id: string; symbol: string; file: string; range: [number, number] };
  language: string;
  resolutionQuality: ResolutionQuality;
  depth: number;
  complete: boolean;
  nodes: RGNode[];
  edges: RGEdge[];
  blindspots: unknown[];     // Layer 2 (presence detection) — not built in this v0
  unresolved: { node: string; query: string; reason: string }[];
}

export interface BuildOptions { maxDepth?: number; maxNodes?: number; }

const SYMBOL_KIND_NAMES: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Function]: "function",
  [vscode.SymbolKind.Constructor]: "constructor",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.Field]: "field",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.Struct]: "struct",
  [vscode.SymbolKind.Enum]: "enum",
};
const CONTAINER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct,
  vscode.SymbolKind.Namespace, vscode.SymbolKind.Enum,
]);
// A class's CORE sub-units (each becomes a core). Data fields/properties are deliberately
// excluded — they are state, not behaviour, so they don't anchor a seam.
const METHOD_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Method, vscode.SymbolKind.Constructor,
]);
const TEST_PATH = /(\.(test|spec)\.[a-z]+$)|((^|\/)(tests?|__tests__|spec)\/)/i;

interface FlatSym { name: string; kind: vscode.SymbolKind; sel: vscode.Range; range: vscode.Range; }


function flatten(syms: vscode.DocumentSymbol[], out: FlatSym[]): void {
  for (const s of syms) {
    out.push({ name: s.name, kind: s.kind, sel: s.selectionRange, range: s.range });
    if (s.children?.length) flatten(s.children, out);
  }
}

// Build the anchor-bounded ResolvedGraph (plan §3 Layer 1 + D5 bounded BFS). Pure over
// the `resolver` — swap the implementation and this is unchanged. Never throws: any query
// that fails becomes an `unresolved[]` entry (UNKNOWN ≠ []), so the worst case is a small,
// honest graph, never a confident wrong one.
export async function buildResolvedGraph(
  resolver: SymbolResolver, anchorUri: vscode.Uri, anchorPos: vscode.Position,
  repoRoot: string, opts: BuildOptions = {},
): Promise<ResolvedGraph> {
  const maxDepth = opts.maxDepth ?? 2;
  const maxNodes = opts.maxNodes ?? 400;
  const rel = (uri: vscode.Uri) => path.relative(repoRoot, uri.fsPath).split(path.sep).join("/");

  const nodes = new Map<string, RGNode>();        // id → node
  const idByKey = new Map<string, string>();      // location key → id
  const edgeSet = new Set<string>();              // "from->to:kind" dedup
  const edges: RGEdge[] = [];
  const unresolved: { node: string; query: string; reason: string }[] = [];
  let counter = 0;

  const keyOf = (uri: vscode.Uri, sel: vscode.Range) => `${uri.fsPath}#${sel.start.line}:${sel.start.character}`;

  // Per-file flattened symbols (cached) → enclosing-container lookup for any location.
  const symCache = new Map<string, FlatSym[] | null>();
  async function flatSyms(uri: vscode.Uri): Promise<FlatSym[] | null> {
    const k = uri.fsPath;
    if (symCache.has(k)) return symCache.get(k)!;
    const r = await resolver.documentSymbols(uri);
    const flat = r.kind === "resolved" ? (() => { const o: FlatSym[] = []; flatten(r.value, o); return o; })() : null;
    symCache.set(k, flat);
    return flat;
  }
  // The nearest CONTAINER symbol (class/interface/namespace) strictly enclosing `sel`.
  async function enclosingOf(uri: vscode.Uri, sel: vscode.Range): Promise<string> {
    const flat = await flatSyms(uri);
    if (!flat) return "";
    let best: FlatSym | undefined;
    for (const s of flat) {
      if (!CONTAINER_KINDS.has(s.kind)) continue;
      if (s.range.contains(sel) && !s.sel.isEqual(sel)) {
        if (!best || best.range.contains(s.range)) best = s;   // innermost container
      }
    }
    return best?.name ?? "";
  }

  function ensureNode(uri: vscode.Uri, name: string, kind: vscode.SymbolKind,
                      sel: vscode.Range, range: vscode.Range, enclosing: string): string {
    const key = keyOf(uri, sel);
    const existing = idByKey.get(key);
    if (existing) return existing;
    const id = `n${++counter}`;
    idByKey.set(key, id);
    const isTest = TEST_PATH.test(rel(uri));
    nodes.set(id, {
      id, symbol: name, kind: isTest ? "test" : (SYMBOL_KIND_NAMES[kind] ?? "symbol"),
      file: rel(uri), range: [range.start.line, range.end.line], enclosing,
      complexity: Math.max(1, range.end.line - range.start.line + 1),
    });
    return id;
  }
  function addEdge(from: string, to: string, kind: string, prov: string): void {
    if (from === to) return;
    const k = `${from}->${to}:${kind}`;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    edges.push({ from, to, kind, provenance: prov });
  }

  const quality = await resolver.resolutionQuality(anchorUri, anchorPos);
  const edgeProv = quality === "FULL" ? "RESOLVED_FULL" : "RESOLVED_PARTIAL";

  // ---- resolve the ANCHOR (the class/method under the cursor) + its members ----
  const docs = await resolver.documentSymbols(anchorUri);
  if (docs.kind === "unknown") {
    return emptyGraph(anchorUri, anchorPos, repoRoot, quality, maxDepth,
                      [{ node: "", query: "documentSymbols", reason: docs.reason }]);
  }
  const flatAnchor: FlatSym[] = [];
  flatten(docs.value, flatAnchor);
  // innermost symbol whose range contains the cursor; prefer a container (the class) if one
  // encloses it, so a click anywhere in the class anchors the whole class.
  const containing = flatAnchor.filter((s) => s.range.contains(anchorPos));
  if (!containing.length) {
    return emptyGraph(anchorUri, anchorPos, repoRoot, quality, maxDepth,
                      [{ node: "", query: "anchorAtCursor", reason: "no_symbol_at_cursor" }]);
  }
  // The anchor is the OUTERMOST symbol under the cursor (the class/component the user
  // posits), not an inner local — a click anywhere inside it anchors the whole unit.
  containing.sort((a, b) => (a.range.contains(b.range) ? -1 : 1));   // outermost first
  const anchorSym = containing.find((s) => CONTAINER_KINDS.has(s.kind)) ?? containing[0];
  const anchorEnc = await enclosingOf(anchorUri, anchorSym.sel);
  const anchorId = ensureNode(anchorUri, anchorSym.name, anchorSym.kind, anchorSym.sel, anchorSym.range, anchorEnc);

  // The CORE sub-units, relative to the anchor:
  //   - a CLASS decomposes into its METHODS (each a core, so we find who uses each method);
  //   - a function / component is ONE core. Either way the anchor itself is always seeded, so
  //     we find who uses the class/component as a whole.
  const isClassLike = CONTAINER_KINDS.has(anchorSym.kind);
  const members = isClassLike
    ? flatAnchor.filter((s) => s !== anchorSym && anchorSym.range.contains(s.range) && METHOD_KINDS.has(s.kind))
    : [];
  const coreIds = new Set<string>([anchorId]);
  const seeds: { id: string; uri: vscode.Uri; sel: vscode.Range }[] = [{ id: anchorId, uri: anchorUri, sel: anchorSym.sel }];
  for (const m of members) {
    const id = ensureNode(anchorUri, m.name, m.kind, m.sel, m.range, anchorSym.name);
    coreIds.add(id);
    seeds.push({ id, uri: anchorUri, sel: m.sel });
  }

  // The innermost named symbol enclosing a reference site — the DEPENDENT that USES the
  // anchor (the consumer). This is the link.
  async function consumerAt(uri: vscode.Uri, at: vscode.Range): Promise<FlatSym | undefined> {
    const flat = await flatSyms(uri);
    if (!flat) return undefined;
    let best: FlatSym | undefined;
    for (const s of flat) {
      if (s.range.contains(at.start) && (!best || best.range.contains(s.range))) best = s;
    }
    return best;
  }

  // ---- bounded BFS over the USAGE graph: where the anchor is USED, not what it uses ----
  // (plan §4: find-references is the ground truth of links). From each core we find its
  // reference sites; the symbol enclosing each site, in ANOTHER file, is a consumer = a link.
  // Then we walk outward (who uses the consumers) to `maxDepth` — the blast radius.
  type Frontier = { id: string; uri: vscode.Uri; pos: vscode.Position; depth: number };
  const queue: Frontier[] = seeds.map((s) => ({ id: s.id, uri: s.uri, pos: s.sel.start, depth: 0 }));
  const expanded = new Set<string>();
  let truncated = false;

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    if (expanded.has(cur.id)) continue;
    expanded.add(cur.id);
    if (nodes.size >= maxNodes) { truncated = true; break; }

    const refs = await resolver.references(cur.uri, cur.pos);
    if (refs.kind === "unknown") {
      unresolved.push({ node: cur.id, query: "references", reason: refs.reason });
      continue;
    }
    for (const loc of refs.value) {
      // A reference in the anchor's OWN file is internal (the declaration, or a sibling using
      // it) — the usage map is about consumers ELSEWHERE in the system.
      if (cur.depth === 0 && loc.uri.fsPath === anchorUri.fsPath) continue;
      const consumer = await consumerAt(loc.uri, loc.range);
      if (!consumer) continue;                              // a usage not inside a named symbol
      const enc = await enclosingOf(loc.uri, consumer.sel);
      const cid = ensureNode(loc.uri, consumer.name, consumer.kind, consumer.sel, consumer.range, enc);
      if (cid === cur.id || coreIds.has(cid)) continue;     // self-reference / the anchor itself
      addEdge(cid, cur.id, "reference", edgeProv);          // consumer USES cur (the dependency edge)
      queue.push({ id: cid, uri: loc.uri, pos: consumer.sel.start, depth: cur.depth + 1 });
    }
  }

  return {
    version: 1,
    anchor: { id: anchorId, symbol: anchorSym.name, file: rel(anchorUri),
              range: [anchorSym.range.start.line, anchorSym.range.end.line] },
    language: vscode.window.activeTextEditor?.document.languageId ?? "",
    resolutionQuality: quality,
    depth: maxDepth,
    complete: !truncated,
    nodes: [...nodes.values()],
    edges,
    blindspots: [],
    unresolved,
  };
}

// Identify the ANCHOR symbol under the cursor using ONLY `documentSymbols` — a single-file query
// that the language server answers reliably (unlike cross-project `references`, which is
// project-scoped and monorepo-blind — memory: lsp-references-monorepo-blind). This is the LSP's
// kept role once consumer DISCOVERY moves to the deterministic import scan: name the anchor, hand
// (symbol, file) to the Python scan front. Returns null if no symbol resolves at the cursor.
export async function anchorSymbolAt(
  resolver: SymbolResolver, anchorUri: vscode.Uri, anchorPos: vscode.Position, repoRoot: string,
): Promise<{ symbol: string; file: string; range: [number, number]; kind: string } | null> {
  const docs = await resolver.documentSymbols(anchorUri);
  if (docs.kind !== "resolved") return null;
  const flat: FlatSym[] = [];
  flatten(docs.value, flat);
  const containing = flat.filter((s) => s.range.contains(anchorPos));
  if (!containing.length) return null;
  containing.sort((a, b) => (a.range.contains(b.range) ? -1 : 1));   // outermost first
  const sym = containing.find((s) => CONTAINER_KINDS.has(s.kind)) ?? containing[0];
  const file = path.relative(repoRoot, anchorUri.fsPath).split(path.sep).join("/");
  return { symbol: sym.name, file, range: [sym.range.start.line, sym.range.end.line],
           kind: SYMBOL_KIND_NAMES[sym.kind] ?? "symbol" };
}

function emptyGraph(uri: vscode.Uri, pos: vscode.Position, repoRoot: string,
                    quality: ResolutionQuality, depth: number,
                    unresolved: { node: string; query: string; reason: string }[]): ResolvedGraph {
  const rel = path.relative(repoRoot, uri.fsPath).split(path.sep).join("/");
  return {
    version: 1, anchor: { id: "", symbol: "", file: rel, range: [pos.line, pos.line] },
    language: vscode.window.activeTextEditor?.document.languageId ?? "",
    resolutionQuality: quality, depth, complete: false,
    nodes: [], edges: [], blindspots: [], unresolved,
  };
}
