// SHARED-KEY coupling ENGINE — the framework- and language-agnostic core. Two front-ends feed it:
//   • the deterministic FLOOR — framework adapters (./adapters), each delegating syntax to a language
//     provider (core/resolve/languages); and
//   • tier-3 LLM (llm_discovery.discover_keys) — proposes keys cross-framework that ground HERE.
// The reusable piece is `shared_key_index`: a repo-wide map of who PRODUCES vs CONSUMES each key. A
// key the anchor produces surfaces its consumers; one it consumes surfaces its producers (so a writer
// reaches the UI that reads it, and a reader reaches the backend that wrote it). Edges are
// RESOLVED_PARTIAL crossings — pruned by the relevance pass, never asserted as a hard call.
import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type Ctx, makeCtx, available, lang_for, _FUNCLIKE, _CLASS_KINDS, _METHOD_KINDS, _NAME_KINDS } from "../atoms.js";
import { endsWithSourceExt, SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { normpath, walk } from "../../core/resolve/walk.js";
import type { Access, ProposedKey, CouplingNode, Crossing, Blindspot } from "./types.js";
import { EngineCtx } from "../engine_ctx.js";
import { kindOf, scan_file_keys, KEY_EDGE_KINDS, KEY_NODE_KINDS, KEY_PRODUCE_EDGE_KINDS, DOMAIN_SUBJECT_KINDS } from "./adapters/index.js";
import { COUPLING } from "./config.js";

export type { KeyHit, KeyKind, Access, ProposedKey } from "./types.js";
export { ADAPTERS, scan_file_keys } from "./adapters/index.js";

// Classification predicates — the data-coupling VOCABULARY exposed as BEHAVIOUR, not raw kind Sets.
// Consumers (the grow loop, the seam assembler) ask coupling "is this edge a crossing? this node a flow
// subject? this a produce-edge?" instead of importing the Sets, so coupling's representation stays private.
export const isCouplingCrossing = (edgeKind: string): boolean => KEY_EDGE_KINDS.has(edgeKind);
export const isFlowSubject = (nodeKind: string): boolean => KEY_NODE_KINDS.has(nodeKind);
export const isProduceEdge = (edgeKind: string): boolean => KEY_PRODUCE_EDGE_KINDS.has(edgeKind);
export const isDomainSubject = (nodeKind: string): boolean => DOMAIN_SUBJECT_KINDS.has(nodeKind);

const READER_CAP = COUPLING.readerCap;                          // materialise at most this many complement nodes per key
const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };
const keyId = (kind: string, value: string) => `${kind} ${value}`;   // the kind+value identity of a shared key

// NOTE: the LLM key pass is no longer a per-anchor call here — it's the repo-wide, batched, cached
// `llm_key_index` (anchor keys come from that index via resolveCoupling, below). The old per-anchor
// `maybe_discover_keys` + its budget were removed (2026-06-19); `attach` still consumes the grounded
// `proposed` keys that index produces.

// ---- the repo-wide GROUNDING INDEX: for each key, who PRODUCES it (writers) vs who CONSUMES it
// (readers), found by scanning every file once. This is what turns "the anchor produces `payments`"
// into "…and these files read it". Example:
//   "db-table payments" → { producers: [billing.rb:40],            // the writers
//                           consumers: [report.rb:12, dash.tsx:88] }  // the readers
type KeyIndex = Map<string, { producers: Access[]; consumers: Access[] }>;

const _HTTP_ROUTE = "http-route";
// Route patterns rarely equal a caller URL byte-for-byte: a handler `@WebServlet("/document/*")` is
// mounted under a context path the caller spells in full (`/manage/rest/member/document`). So for
// http-route keys ONLY, couple a handler to a caller when one path's segments are a whole-SEGMENT SUFFIX
// of the other's (after dropping a trailing `/*` wildcard) — whole-segment so `/doc` ≁ `/mydoc`.
const routeSegs = (value: string): string[] => value.replace(/\/\*+$/, "").split("/").filter(Boolean);
function routeSuffixMatch(a: string, b: string): boolean {
  const A = routeSegs(a), B = routeSegs(b);
  if (!A.length || !B.length) return false;
  const [long, short] = A.length >= B.length ? [A, B] : [B, A];
  return short.every((s, i) => long[long.length - short.length + i] === s);
}
// The OTHER side of an access — its COMPLEMENTS. If the anchor PRODUCES the key we return its consumers;
// if it CONSUMES, we return its producers:
//   produces `payments`  → [report.rb:12, dash.tsx:88]   (the readers)
//   consumes `payments`  → [billing.rb:40]               (the writer)
// This is a one-directional lookup keyed PURELY on the shared key string — there is NO check that the
// complement points back at THIS producer. The only evidence is "both name the same key", which is why
// every edge `attach` emits is RESOLVED_PARTIAL (a shared-name crossing), never an asserted call.
// Exact-key matches, plus (for http-route) suffix-aliased route keys, so a full-URL caller grounds to a
// sub-path/wildcard handler and vice-versa. Dedup is handled downstream (complementFiles).
function otherSide(index: KeyIndex, kind: string, value: string, produces: boolean): Access[] {
  const exact = index.get(keyId(kind, value));
  const out: Access[] = [...((produces ? exact?.consumers : exact?.producers) ?? [])];
  if (kind !== _HTTP_ROUTE) return out;
  const prefix = `${_HTTP_ROUTE} `;
  for (const [k, v] of index) {
    if (!k.startsWith(prefix)) continue;
    const val = k.slice(prefix.length);
    if (val === value || !routeSuffixMatch(val, value)) continue;
    out.push(...(produces ? v.consumers : v.producers));
  }
  return out;
}

// Merge a second index (e.g. the carrier-channel data-file keys) into a copy of the base — concatenating
// producers/consumers on shared keys. Non-mutating so the cached base index stays clean.
function _merge_index(base: KeyIndex, extra: KeyIndex): KeyIndex {
  const out: KeyIndex = new Map();
  for (const [k, v] of base) out.set(k, { producers: [...v.producers], consumers: [...v.consumers] });
  for (const [k, v] of extra) {
    if (!out.has(k)) out.set(k, { producers: [], consumers: [] });
    out.get(k)!.producers.push(...v.producers);
    out.get(k)!.consumers.push(...v.consumers);
  }
  return out;
}

export function shared_key_index(repo: string, skipDirs: Set<string>, ctx: EngineCtx): KeyIndex {
  if (ctx.sharedKey.has(repo)) return ctx.sharedKey.get(repo)!;
  const idx: KeyIndex = new Map();
  for (const [dir, files] of walk(repo, skipDirs)) {
    for (const fn of files) {
      if (!endsWithSourceExt(fn)) continue;
      let text: string;
      try { text = readFileSync(join(dir, fn), "utf-8"); } catch { continue; }
      const rel = relative(repo, join(dir, fn));
      const hits = scan_file_keys(rel, text);
      if (!hits.length) continue;
      for (const h of hits) {
        const k = keyId(h.kind, h.value);
        if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
        (h.produces ? idx.get(k)!.producers : idx.get(k)!.consumers).push({ file: rel, line: h.line });
      }
    }
  }
  ctx.sharedKey.set(repo, idx);
  return idx;
}

function _name_of(ctx: Ctx, node: any): string | null {
  for (const c of ctx.children(node)) if (_NAME_KINDS.has(c.type)) return ctx.text(c);
  return null;
}

// The named function/method/class enclosing `line` in a complement file (smallest wins), or a module
// stub for a top-level access (e.g. a Next.js `export const GET = …` route). Lazy — only ≤CAP parsed.
export async function complement_unit(repo: string, file: string, line: number): Promise<{ symbol: string; kind: string; start: number; end: number }> {
  const fallback = { symbol: stem(file), kind: "module", start: line, end: line };
  const lang = lang_for(file);
  if (!lang || !available()) return fallback;
  let ctx: Ctx | null;
  try { ctx = await makeCtx(readFileSync(join(repo, file), "utf-8"), lang); } catch { return fallback; }
  if (!ctx) return fallback;
  let best: { symbol: string; kind: string; start: number; end: number } | null = null;
  for (const n of ctx.collect(ctx.root, (k) => _FUNCLIKE.has(k) || _CLASS_KINDS.has(k))) {
    const [s, e] = ctx.span(n);
    if (s > line || line > e) continue;
    const nm = _name_of(ctx, n);
    if (!nm) continue;
    if (!best || (e - s) < (best.end - best.start)) {
      best = { symbol: nm, kind: _CLASS_KINDS.has(n.type) ? "class" : _METHOD_KINDS.has(n.type) ? "method" : "function", start: s, end: e };
    }
  }
  return best ?? fallback;
}

const CHAIN_DEPTH = COUPLING.chainDepth;   // chain the data-flow boundary this many hops past the anchor (db-table reader → ITS http-route)

// The coupling sub-graph `attach` builds, as ONE mutable accumulator threaded through the chain recursion
// (so a deep recursive call appends to the same arrays, with no by-hand counter plumbing). It OWNS the
// `dc{n}` node-id sequence, seeded from the engine-wide counter: addNode() mints the next id, stores the
// node, and returns it — the single place ids are minted, so callers never increment a counter themselves.
class CouplingGraph {
  readonly nodes: CouplingNode[] = [];
  readonly edges: Crossing[] = [];
  readonly blindspots: Blindspot[] = [];
  constructor(private _counter: number) {}
  addNode(node: Omit<CouplingNode, "id">): string {   // mints the id (the single place ids are minted)
    this._counter += 1;
    const id = `dc${this._counter}`;
    this.nodes.push({ id, ...node });
    return id;
  }
  addEdge(edge: Crossing): void { this.edges.push(edge); }
  addBlindspot(blindspot: Blindspot): void { this.blindspots.push(blindspot); }
  get counter(): number { return this._counter; }   // the advanced id counter, for the caller to continue from
}

// merge two repo-wide key indexes (carrier-channel + LLM-key) — concat producers/consumers on shared keys.
type _KIdx = Map<string, { producers: any[]; consumers: any[] }>;
function _merge_key_index(a: _KIdx | undefined, b: _KIdx | undefined): _KIdx | undefined {
  if (!a) return b; if (!b) return a;
  const out: _KIdx = new Map(a);
  for (const [k, v] of b) {
    const e = out.get(k);
    if (e) out.set(k, { producers: [...e.producers, ...v.producers], consumers: [...e.consumers, ...v.consumers] });
    else out.set(k, { producers: [...v.producers], consumers: [...v.consumers] });
  }
  return out;
}

// PUBLIC per-anchor ENTRYPOINT — resolve the data-coupling boundary for an anchor span and return a DELTA
// (nodes/edges/blindspots + the advanced id counter) for the caller to merge into its graph. Coupling owns
// its OWN grounding here: the Ruby carrier-channel (teacher 1/2/3, homemade data-file coupling) PLUS the
// language-agnostic LLM key index (the framework-AGNOSTIC grounding for floor-blind files) PLUS the
// anchor's proposed keys. So a caller never orchestrates coupling internals nor hands coupling its arrays.
// Self-gates to a no-op delta when data-coupling is off; the grounding self-gates to zero cost without
// `--data-coupling llm` or a prior `.seam/` cache. (Was scan/import_scan `_carrier_extra` + the `attach` call.)
export interface CouplingOpts { dataCoupling?: boolean; llm?: boolean; model?: string; claudeBin?: string | null }
export async function resolveCoupling(
  repo: string, anchorId: string, anchorFile: string, anchorText: string, lo: number, hi: number,
  counter: number, opts: CouplingOpts = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<{ nodes: any[]; edges: any[]; blindspots: any[]; counter: number }> {
  const graph = new CouplingGraph(counter);
  if (opts.dataCoupling === false) return { nodes: graph.nodes, edges: graph.edges, blindspots: graph.blindspots, counter };
  const llmOpts = { llm: opts.llm, model: opts.model, claudeBin: opts.claudeBin };
  let accs: { kind: string; value: string; produces: boolean; line: number }[] | undefined, index: _KIdx | undefined;
  if (anchorFile.endsWith(".rb") || anchorFile.endsWith(".rake")) {
    const cc = await import("./carrier/engine.js");
    index = await cc.carrierChannelIndex(repo, llmOpts, ctx);            // batched carrier-synth prefetch (warms the cache)
    accs = await cc.anchorCarrierAccs(repo, anchorFile, anchorText, lo, hi, llmOpts, ctx);
  }
  const lk = await import("./llm_key_index.js");
  const ki = await lk.llmKeyIndex(repo, llmOpts, ctx);                   // repo-wide grounding (the other side), cached
  if (ki.size) index = _merge_key_index(index, ki);
  const proposed = await lk.anchorProposedKeys(repo, anchorFile, anchorText, llmOpts, ctx);   // the anchor's own gaps
  await attach(graph, repo, anchorId, anchorFile, anchorText, lo, hi, proposed ?? [], undefined, undefined, { accs, index }, ctx);
  return { nodes: graph.nodes, edges: graph.edges, blindspots: graph.blindspots, counter: graph.counter };
}

// One key the anchor body touches. `fromScan` separates a deterministic-FLOOR key (scan or carrier) from
// an LLM proposal — an ungrounded proposal becomes a blindspot, an ungrounded floor key is silent.
type AnchorKey = { kind: string; value: string; produces: boolean; line: number; fromScan: boolean };

// Collect the keys the anchor body touches, from three sources, deduped (earliest line wins):
//   1. the deterministic per-file scan (framework adapters)          ┐ both are the deterministic FLOOR,
//   2. carrier-channel accesses (Ruby homemade data-file wrappers)   ┘ so they count as fromScan = true
//   3. LLM-proposed keys — kept only where the floor didn't already cover them (fromScan = false)
// e.g. a `Payment.create(...)` write in the span → AnchorKey{ kind:"db-table", value:"payments", produces:true }.
function collectAnchorKeys(
  anchorFile: string, anchorText: string, spanLo: number, spanHi: number,
  carrierAccs: { kind: string; value: string; produces: boolean; line: number }[],
  proposed: ProposedKey[],
): Map<string, AnchorKey> {
  const anchorKeys = new Map<string, AnchorKey>();
  const accessId = (k: { kind: string; value: string; produces: boolean }) => `${k.kind} ${k.value} ${k.produces}`;
  for (const hit of [...scan_file_keys(anchorFile, anchorText), ...carrierAccs]) {
    if (hit.line < spanLo || hit.line > spanHi) continue;
    const id = accessId(hit);
    if (!anchorKeys.has(id) || hit.line < anchorKeys.get(id)!.line)
      anchorKeys.set(id, { kind: hit.kind, value: hit.value, produces: hit.produces, line: hit.line, fromScan: true });
  }
  for (const proposedKey of proposed) {
    const id = accessId(proposedKey);
    if (!anchorKeys.has(id))
      anchorKeys.set(id, { kind: proposedKey.kind, value: proposedKey.value, produces: proposedKey.produces, line: spanLo, fromScan: false });
  }
  return anchorKeys;
}

// ---- RELEVANCE ranking for the capped fan (a separate concern: SCORE here, APPLY just below) ----------
// We only materialise READER_CAP complements per key, so when a key has many we must keep the most on-
// intent ones. The signal: a complement file on the OTHER side of SEVERAL of the anchor's keys is coupled
// through more than one data channel — clearly part of the flow — while one sharing a single hub key is
// generic noise. So we score each complement file by how many DISTINCT anchor keys name it on their far
// side. Example — the anchor (a payment flow) touches keys `payments` AND `members`:
//   billing_report.rb  reads payments + members  → score 2   (kept first — coupled through both channels)
//   user_profile.tsx   reads members only        → score 1   (demoted — only shares the generic hub table)
// Cheap & deterministic: reuses the grounding index already built; demotes hub-table crowds below the cap.
function rankComplementsByCoOccurrence(
  anchorKeys: Iterable<AnchorKey>, index: KeyIndex, anchorPath: string,
): Map<string, number> {
  const coOccurrenceByFile = new Map<string, number>();
  for (const key of anchorKeys) {
    const seenFiles = new Set<string>();
    for (const complement of otherSide(index, key.kind, key.value, key.produces)) {
      if (normpath(complement.file) === anchorPath || seenFiles.has(complement.file)) continue;
      seenFiles.add(complement.file);
      coOccurrenceByFile.set(complement.file, (coOccurrenceByFile.get(complement.file) ?? 0) + 1);
    }
  }
  return coOccurrenceByFile;
}

// APPLY the scores: order one key's complement files by co-occurrence DESC (relevance), then file/line ASC
// (a stable tie-break). The first READER_CAP of the result survive the cap. Input/output are [file, line].
function orderComplementsByRelevance(
  complementFiles: Map<string, number>, coOccurrenceByFile: Map<string, number>,
): [string, number][] {
  return [...complementFiles.entries()].sort((x, y) => {
    const scoreX = coOccurrenceByFile.get(x[0]) ?? 0, scoreY = coOccurrenceByFile.get(y[0]) ?? 0;
    if (scoreX !== scoreY) return scoreY - scoreX;                 // higher cross-key co-occurrence first
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1];       // then stable file, then line
  });
}

// The NEAR-side lookup for one key: its complement files — the OTHER side from the index (exact + route
// suffix aliases), the anchor's own file dropped, deduped to file → earliest line (one complement node per
// file, located at its first access).
function collectComplementFiles(index: KeyIndex, key: AnchorKey, anchorPath: string): Map<string, number> {
  const complementFiles = new Map<string, number>();
  for (const access of otherSide(index, key.kind, key.value, key.produces)) {
    if (normpath(access.file) === anchorPath) continue;
    if (!complementFiles.has(access.file) || access.line < complementFiles.get(access.file)!) complementFiles.set(access.file, access.line);
  }
  return complementFiles;
}

// The shared, per-attach context — bundled so the helpers below take a `scope`, not a dozen parameters. A
// fresh scope is built per attach call (its `depth` is the current chain level; the recursion makes a new
// one at depth-1).
interface AttachScope {
  graph: CouplingGraph;
  repo: string;
  index: KeyIndex;                  // the grounding index (base, optionally carrier-extended)
  anchorPath: string;
  coOccurrence: Map<string, number>;
  depth: number;
  carrier: { accs?: { kind: string; value: string; produces: boolean; line: number }[]; index?: KeyIndex };
  ctx: EngineCtx;
}

// CROSS the boundary (the FAR side): rank this key's complement files, materialise the top READER_CAP as
// nodes with boundary→complement crossings, chain one hop into each, and record the over-cap tail as a
// fanout blindspot. `surfacedKeys` already carries this boundary's key, so the chain can't loop back in.
async function crossBoundary(
  scope: AttachScope, boundaryId: string, key: AnchorKey, complementFiles: Map<string, number>, surfacedKeys: Set<string>,
): Promise<void> {
  const { graph, repo, depth, carrier, ctx, coOccurrence } = scope;
  const adapter = kindOf(key.kind);
  const complementProduces = !key.produces;
  const rankedComplements = orderComplementsByRelevance(complementFiles, coOccurrence);
  for (const [file, line] of rankedComplements.slice(0, READER_CAP)) {
    const unit = await complement_unit(repo, file, line);
    const complementId = graph.addNode({ symbol: unit.symbol, kind: unit.kind, file, range: [unit.start, unit.end], enclosing: "", complexity: Math.max(1, unit.end - unit.start + 1), coupling: true });
    graph.addEdge({ from: boundaryId, to: complementId, kind: complementProduces ? adapter.produceEdge : adapter.consumeEdge, provenance: "RESOLVED_PARTIAL" });
    // CHAIN: this complement may itself sit on the next boundary (the route handler that SERVES what the UI
    // fetches). Recurse one hop into its body, scanning ITS keys — `surfacedKeys` blocks the table it reads.
    if (depth > 0) {
      let complementText = "";
      try { complementText = readFileSync(join(repo, file), "utf-8"); } catch { /* unreadable complement → no chain */ }
      if (complementText) await attach(graph, repo, complementId, file, complementText, unit.start, unit.end, [], depth - 1, surfacedKeys, { index: carrier.index }, ctx);
    }
  }
  if (rankedComplements.length > READER_CAP) {
    graph.addBlindspot({ node: boundaryId, mechanism: "shared-key-fanout",
      evidence: `'${key.value}' (${key.kind}) is ${complementProduces ? "written" : "read"} in ${rankedComplements.length} files (showing ${READER_CAP}) — a data-flow boundary, not a call`,
      candidates: rankedComplements.slice(READER_CAP).map(([file]) => ({ file, symbol: key.value, provenance: "SUGGESTED" })) });
  }
}

// Attach the shared-key boundaries for one anchor span into `graph`: for each key it PRODUCES surface the
// consumers, for each it CONSUMES surface the producers — as a boundary node + a (capped) crossing fan.
// Keys come from collectAnchorKeys (scan + carrier floor + LLM proposals). Per key, two halves:
//   NEAR side (here)         — find the complement files, then emit the boundary node + anchor→boundary edge
//   FAR side (crossBoundary) — rank + materialise the complements, draw boundary→complement edges, chain on
// A proposed key the index can't ground → a blindspot (an LLM hypothesis, not a materialised node).
// Appends to `graph` (which owns id minting); returns nothing. Self-gating: no keys → no-op.
export async function attach(graph: CouplingGraph, repo: string, anchorId: string, anchorFile: string, anchorText: string,
    spanLo: number, spanHi: number, proposed: ProposedKey[] = [],
    depth = CHAIN_DEPTH, seenKeys: Set<string> = new Set(),
    carrier: { accs?: { kind: string; value: string; produces: boolean; line: number }[]; index?: KeyIndex } = {},
    ctx: EngineCtx = new EngineCtx()): Promise<void> {
  if (!available()) return;

  const anchorKeys = collectAnchorKeys(anchorFile, anchorText, spanLo, spanHi, carrier.accs ?? [], proposed);
  if (!anchorKeys.size) return;

  // the repo-wide grounding index, optionally extended with the carrier-channel index (data-file keys)
  const baseIndex = shared_key_index(repo, SKIP_DIRS, ctx);
  const groundingIndex: KeyIndex = carrier.index ? _merge_index(baseIndex, carrier.index) : baseIndex;

  const anchorPath = normpath(anchorFile);
  const coOccurrenceByFile = rankComplementsByCoOccurrence(anchorKeys.values(), groundingIndex, anchorPath);
  const scope: AttachScope = { graph, repo, index: groundingIndex, anchorPath, coOccurrence: coOccurrenceByFile, depth, carrier, ctx };

  const boundaryNodeIdByKey = new Map<string, string>();   // key identity → boundary node id (one per key)
  const surfacedKeys = new Set(seenKeys);                  // ancestor keys + the ones THIS call surfaces (fed to the chain recursion)

  for (const key of [...anchorKeys.values()].sort((x, y) => (x.value < y.value ? -1 : x.value > y.value ? 1 : 0))) {
    if (seenKeys.has(keyId(key.kind, key.value))) continue;   // an ancestor already surfaced this boundary — don't loop back
    const adapter = kindOf(key.kind);

    // NEAR side: which files sit on the other side of this key?
    const complementFiles = collectComplementFiles(groundingIndex, key, anchorPath);
    if (!complementFiles.size) {
      // an LLM-proposed key the deterministic index can't ground → a blindspot, not a materialised node
      if (!key.fromScan) graph.addBlindspot({ node: anchorId, mechanism: "llm-proposed-key",
        evidence: `LLM proposes a ${key.kind} coupling on '${key.value}' (${key.produces ? "produced" : "consumed"} here) the deterministic scan didn't index`, candidates: [] });
      continue;
    }

    // emit (once) the boundary node standing for this key, plus the anchor→boundary crossing edge
    let boundaryId = boundaryNodeIdByKey.get(keyId(key.kind, key.value));
    if (boundaryId === undefined) {
      boundaryId = graph.addNode({ symbol: key.value, kind: adapter.nodeKind, file: anchorFile, range: [key.line, key.line], enclosing: "", complexity: 1, coupling: true });
      boundaryNodeIdByKey.set(keyId(key.kind, key.value), boundaryId);
    }
    surfacedKeys.add(keyId(key.kind, key.value));   // mark before recursing so a complement reading this same key skips it
    graph.addEdge({ from: anchorId, to: boundaryId, kind: key.produces ? adapter.produceEdge : adapter.consumeEdge, provenance: "RESOLVED_PARTIAL", line: key.line });

    // FAR side: cross the boundary out to its (ranked, capped) complements
    await crossBoundary(scope, boundaryId, key, complementFiles, surfacedKeys);
  }
}
