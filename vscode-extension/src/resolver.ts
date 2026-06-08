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

  async resolutionQuality(uri: vscode.Uri, pos: vscode.Position): Promise<ResolutionQuality> {
    // Probe, don't assume (plan §4). Symbols present + a precise call graph at the anchor
    // ⇒ FULL. Symbols but no call hierarchy ⇒ HEURISTIC (we can see structure, not edges).
    // Nothing ⇒ NONE. (PARTIAL is detected later, per-query, when some calls go UNKNOWN.)
    const docs = await this.documentSymbols(uri);
    if (docs.kind === "unknown") return "NONE";
    const ch = await this.prepareCallHierarchy(uri, pos);
    if (ch.kind === "unknown" || !ch.value.length) return "HEURISTIC";
    const out = await this.outgoingCalls(ch.value[0]);
    return out.kind === "resolved" ? "FULL" : "HEURISTIC";
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

// A definition result is either a Location or a LocationLink — normalise to {uri, range}.
function locTarget(l: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
  return "targetUri" in l ? { uri: l.targetUri, range: l.targetRange } : { uri: l.uri, range: l.range };
}

// The local names an `import` binds + where each appears (for the definition provider). This
// is how we recover a component's wiring that the call graph misses: JSX elements, hooks and
// utils are all IMPORTED, so the imports the anchor body uses ARE its links. Type-only imports
// are skipped (no runtime wiring). Multiline `{ … }` blocks are handled.
interface ImportBinding { local: string; pos: vscode.Position; }
function parseImportBindings(text: string, doc: vscode.TextDocument): ImportBinding[] {
  const out: ImportBinding[] = [];
  const re = /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"][^'"]+['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const seg = m[0];
    if (/^import\s+type\b/.test(seg)) continue;                 // whole type-only import
    const add = (local: string) => {
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) return;
      out.push({ local, pos: doc.positionAt(m!.index + seg.indexOf(local)) });
    };
    if (m[1]) {
      for (const part of m[1].split(",")) {
        const raw = part.trim();
        if (!raw || raw.startsWith("type ")) continue;          // per-binding `type Foo`
        add(raw.split(/\s+as\s+/).pop()!.trim());               // `a as b` → b
      }
    } else if (m[2]) add(m[2]);
    else if (m[3]) add(m[3]);
  }
  return out;
}

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
  // Node from a CallHierarchyItem (a callee/caller), resolving its enclosing container.
  async function nodeFromItem(item: vscode.CallHierarchyItem): Promise<string> {
    const enc = await enclosingOf(item.uri, item.selectionRange);
    return ensureNode(item.uri, item.name, item.kind, item.selectionRange, item.range, enc);
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
  //   - a CLASS decomposes into its METHODS (each a core);
  //   - a function / component is ONE core (its inner `const`s are its BODY, not sub-cores —
  //     promoting them all to core was the "wall of amber" bug). Its value is in what it
  //     wires OUT to, surfaced as links below.
  const isClassLike = CONTAINER_KINDS.has(anchorSym.kind);
  const members = isClassLike
    ? flatAnchor.filter((s) => s !== anchorSym && anchorSym.range.contains(s.range) && METHOD_KINDS.has(s.kind))
    : [];
  const seeds: { id: string; uri: vscode.Uri; sel: vscode.Range }[] = [];
  if (members.length) {
    for (const m of members) {
      const id = ensureNode(anchorUri, m.name, m.kind, m.sel, m.range, anchorSym.name);
      seeds.push({ id, uri: anchorUri, sel: m.sel });
    }
  } else {
    seeds.push({ id: anchorId, uri: anchorUri, sel: anchorSym.sel });   // a function / single-unit anchor
  }

  // ---- bounded BFS over the resolved CALL GRAPH (outgoing from the anchor's members) ----
  type Frontier = { id: string; uri: vscode.Uri; sel: vscode.Range; depth: number };
  const queue: Frontier[] = seeds.map((s) => ({ ...s, depth: 0 }));
  const expanded = new Set<string>();
  let truncated = false;

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    const ek = `${cur.uri.fsPath}#${cur.sel.start.line}`;
    if (expanded.has(ek)) continue;
    expanded.add(ek);
    if (nodes.size >= maxNodes) { truncated = true; break; }

    const ch = await resolver.prepareCallHierarchy(cur.uri, cur.sel.start);
    if (ch.kind === "unknown") { unresolved.push({ node: cur.id, query: "prepareCallHierarchy", reason: ch.reason }); continue; }
    if (!ch.value.length) continue;
    const item = ch.value[0];

    const out = await resolver.outgoingCalls(item);
    if (out.kind === "unknown") {
      unresolved.push({ node: cur.id, query: "outgoingCalls", reason: out.reason });
    } else {
      for (const call of out.value) {
        // Skip a callee DEFINED INSIDE the anchor (an internal local of the body) — it is
        // not a boundary crossing, so it is not a node. A call to an existing node (a sibling
        // class method) is kept: that is a real core→core edge (cohesion). Cross-boundary
        // callees ARE added — they are the links the anchor wires out to.
        const internal = call.to.uri.fsPath === anchorUri.fsPath
          && anchorSym.range.contains(call.to.range)
          && !idByKey.has(keyOf(call.to.uri, call.to.selectionRange));
        if (internal) continue;
        const toId = await nodeFromItem(call.to);
        addEdge(cur.id, toId, "call", edgeProv);
        queue.push({ id: toId, uri: call.to.uri, sel: call.to.selectionRange, depth: cur.depth + 1 });
      }
    }
    // incoming callers of the anchor's OWN members (depth 0) = the system wiring INTO the
    // anchor (links). Bounded to depth 0 so we don't fan the whole reverse graph in.
    if (cur.depth === 0) {
      const inc = await resolver.incomingCalls(item);
      if (inc.kind === "unknown") {
        unresolved.push({ node: cur.id, query: "incomingCalls", reason: inc.reason });
      } else {
        for (const call of inc.value) {
          const fromId = await nodeFromItem(call.from);
          addEdge(fromId, cur.id, "call", edgeProv);
        }
      }
    }
  }

  // AUGMENTATION — import-definition links. A component's wiring is mostly JSX + hooks,
  // which the call graph does NOT see (call hierarchy ignores JSX). So resolve the IMPORTED
  // symbols the anchor body actually uses, via the definition provider: those are the links
  // it wires out to. Robust exactly where call hierarchy is blind (React). Best-effort —
  // a failure to resolve becomes an `unresolved[]` entry, never a fabricated edge.
  try {
    const doc = await vscode.workspace.openTextDocument(anchorUri);
    const text = doc.getText();
    const body = text.slice(doc.offsetAt(anchorSym.range.start), doc.offsetAt(anchorSym.range.end));
    for (const b of parseImportBindings(text, doc)) {
      if (nodes.size >= maxNodes) { truncated = true; break; }
      if (!new RegExp(`\\b${b.local}\\b`).test(body)) continue;        // not used by the anchor
      const def = await resolver.getDefinition(anchorUri, b.pos);
      if (def.kind === "unknown" || !def.value.length) {
        // the LS couldn't resolve this import (the broken-monorepo signature) — record it as
        // UNKNOWN so the blind-spot map shows WHY a link is missing, never silently dropped.
        unresolved.push({ node: anchorId, query: `definition(${b.local})`,
                          reason: def.kind === "unknown" ? def.reason : "no_definition" });
        continue;
      }
      const { uri, range } = locTarget(def.value[0]);
      if (uri.fsPath === anchorUri.fsPath && anchorSym.range.contains(range)) continue;  // internal
      if (uri.fsPath.includes("/node_modules/")) continue;             // framework lib, not first-party wiring
      const enc = await enclosingOf(uri, range);
      const id = ensureNode(uri, b.local, vscode.SymbolKind.Variable, range, range, enc);
      addEdge(anchorId, id, "import", edgeProv);
    }
  } catch { /* augmentation is best-effort; the call-graph result still stands */ }

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
