// SHARED-KEY coupling ENGINE — the framework- and language-agnostic core. It resolves ONE anchor's data
// coupling in five steps, mirroring docs/COUPLING_VOCABULARY.md (and the type-per-step order in ./types):
//   1. SOURCE   gather keys from three front-ends, each tagged with its KeySource. NOT all in one place:
//      • carrier wrappers + LLM (repo-wide, EXPENSIVE, cached on EngineCtx) are assembled UP-FRONT, once
//        per anchor, and passed into runPipeline as its `carrierAccs`/`proposed`  → resolveCoupling · assembleSources
//      • the scan-adapter floor is cheap + span-local, so it's read INLINE        → collectAnchorKeys (also on each chained hop)
//   2. KEY      dedupe those three sources into the keys the span touches          → AnchorKey (in collectAnchorKeys)
//   3. GROUND   repo-wide producers/consumers per key + the "other side" lookup    → shared_key_index · otherSide
//   4. DRAW     the key as a synthetic boundary node between the two sides         → drawBoundary
//   5. WIRE     the produce/consume crossings from real files to that node         → wireNear (near) · crossBoundary (far)
// `runPipeline` (steps 1-inline..5, recursive) is the per-node body; step 1's expensive half runs once before it.
// The reusable piece is `shared_key_index`. A key the anchor produces surfaces its consumers; one it
// consumes surfaces its producers (a writer reaches the UI that reads it, a reader reaches the backend
// that wrote it). Edges are RESOLVED_PARTIAL crossings — pruned by the relevance pass, never a hard call.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Ctx, makeCtx, available, lang_for, _FUNCLIKE, _CLASS_KINDS, _METHOD_KINDS, _NAME_KINDS } from "../atoms.js";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { normpath, walkFiles } from "../../core/resolve/walk.js";
import { type Access, type KeyHit, type AnchorKey, type KeySource, type GroundingIndex, type CouplingNode, type Crossing, type Blindspot, isFloor } from "./types.js";
import { EngineCtx } from "../engine_ctx.js";
import { ADAPTERS, kindOf, scan_file_keys, scannableForKeys, KEY_EDGE_KINDS, KEY_NODE_KINDS, KEY_PRODUCE_EDGE_KINDS, DOMAIN_SUBJECT_KINDS } from "./adapters/index.js";
import { type KeyMatcher, matcherKey, runMatcher, plausibleKeyValue } from "./key_ir.js";
import { listMatchers } from "./key_store.js";
import { scanConstDecls, scanParamSites, resolveParamSites, paramKeysForSpan, type ParamSite } from "./const_keys.js";
import { makeMaskCtx } from "./adapters/util.js";
import { indexCacheEnabled, incrementalScan } from "./index_cache.js";
import { COUPLING } from "./config.js";
import { emit, verbose, timingOn } from "../../core/progress.js";

export type { KeyHit, KeyKind, Access, AnchorKey, KeySource, GroundingIndex } from "./types.js";
export { ADAPTERS, scan_file_keys, scannableForKeys } from "./adapters/index.js";

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
// `maybe_discover_keys` + its budget were removed (2026-06-19); runPipeline still consumes the grounded
// `proposed` keys that index produces.

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// STEP 3 — GROUND: the repo-wide GroundingIndex (who PRODUCES vs CONSUMES each key, by scanning every file
// once) and the `otherSide` lookup across it. This is what turns "the anchor produces `payments`" into
// "…and these files read it". Example:
//   "db-table payments" → { producers: [billing.rb:40],              // the writers
//                           consumers: [report.rb:12, dash.tsx:88] }  // the readers
// ════════════════════════════════════════════════════════════════════════════════════════════════════

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
// every coupling edge emitted is RESOLVED_PARTIAL (a shared-name crossing), never an asserted call.
// Exact-key matches, plus (for http-route) suffix-aliased route keys, so a full-URL caller grounds to a
// sub-path/wildcard handler and vice-versa. Dedup is handled downstream (complementFiles).
function otherSide(index: GroundingIndex, kind: string, value: string, produces: boolean): Access[] {
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

// Combine grounding indexes (the scan floor + the carrier-channel data-file keys + the LLM key index) into
// ONE fresh index — concatenating producers/consumers on shared keys. Non-mutating (fresh arrays, so the
// cached inputs stay clean) and skips undefined parts. The single merge for the whole axis.
export function mergeGrounding(...parts: (GroundingIndex | undefined)[]): GroundingIndex {
  const out: GroundingIndex = new Map();
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of part) {
      if (!out.has(k)) out.set(k, { producers: [], consumers: [] });
      out.get(k)!.producers.push(...v.producers);
      out.get(k)!.consumers.push(...v.consumers);
    }
  }
  return out;
}

// SINGLE-PASS FLOOR BUILDER — read each file ONCE and feed BOTH deterministic floor indices (the shared-key
// adapter scan AND the constant-resolved param-key const/use collection), then discard the text. STREAMING
// (one file in memory at a time, never the repo) and ONE walk instead of two independent full repo reads —
// the big win on a huge repo where the read + comment-mask dominates. Both indices cache on the ctx together;
// honours the size cap (skips minified/generated bundles) and SEAM_NO_ADAPTERS (empty floor).
// What changes the floor OUTPUT for the same files — folded into the disk-cache key so a config change can't
// serve a stale index. (Adapter SET is sourced from the registry, not hardcoded.)
function floorConfigSalt(): string {
  return `cap=${COUPLING.maxScanBytes}|noadapt=${process.env.SEAM_NO_ADAPTERS ?? ""}|adapters=${ADAPTERS.map((a) => a.kind).join(",")}`;
}

// One file's RAW floor contribution — the per-file MAP half of the floor build, kept raw (param sites
// UNRESOLVED) so it can be cached per-file and the cross-file const resolution happens once in the merge.
// JSON-serializable (the incremental cache stores it opaquely).
type FloorContribution = { keys: KeyHit[]; constDecls: [string, string][]; sites: ParamSite[] };
function scanFloorFile(rel: string, text: string): FloorContribution {
  const m = makeMaskCtx(text);                            // ONE mask cache, shared by the adapters AND the param pass
  const keys = scan_file_keys(rel, text, m);              // shared-key adapters (size cap + SEAM_NO_ADAPTERS → [] internally)
  const constDecls: [string, string][] = [];
  const sites: ParamSite[] = [];
  if (process.env.SEAM_NO_ADAPTERS !== "1" && !(COUPLING.maxScanBytes && text.length > COUPLING.maxScanBytes)) {
    const cm = new Map<string, string>();
    scanConstDecls(m.comments, cm); constDecls.push(...cm);
    scanParamSites(m.comments, rel, sites);
  }
  return { keys, constDecls, sites };
}
// The REDUCE half: merge per-file contributions into the shared-key index + the const-resolved param index.
// Const resolution is done HERE (once, in-memory) against the merged const map — that's what makes the
// per-file cache safe across the cross-file `getParameter(CONST)` dependency. Order-stable (walk order).
function mergeFloor(contribs: { rel: string; data: FloorContribution }[]): { shared: GroundingIndex; param: GroundingIndex } {
  const shared: GroundingIndex = new Map();
  const constMap = new Map<string, string>();
  const allSites: ParamSite[] = [];
  for (const { rel, data } of contribs) {
    for (const h of data.keys) {
      const k = keyId(h.kind, h.value);
      if (!shared.has(k)) shared.set(k, { producers: [], consumers: [] });
      (h.produces ? shared.get(k)!.producers : shared.get(k)!.consumers).push({ file: rel, line: h.line });
    }
    for (const [n, v] of data.constDecls) if (!constMap.has(n)) constMap.set(n, v);
    allSites.push(...data.sites);
  }
  const param = process.env.SEAM_NO_ADAPTERS === "1" ? new Map() as GroundingIndex : resolveParamSites(allSites, constMap);
  return { shared, param };
}

// The per-file floor scan, computed ONCE per run (memoized on the ctx) and shared by the floor build AND the
// llm-key index's floor reconciliation — so the floor is never scanned twice (the old assemble duplication).
// Disk-cached + incremental when SEAM_INDEX_CACHE=1; a plain (memory-safe, oversize-skipping) walk otherwise.
export function floorContributions(repo: string, skipDirs: Set<string>, ctx: EngineCtx): { rel: string; data: FloorContribution }[] {
  const memo = ctx.floorContribs.get(repo) as { rel: string; data: FloorContribution }[] | undefined;
  if (memo) return memo;
  let contribs: { rel: string; data: FloorContribution }[];
  if (indexCacheEnabled()) {
    emit("Scanning floor (incremental, cached per file)…");
    contribs = incrementalScan(repo, skipDirs, scannableForKeys, floorConfigSalt(), scanFloorFile);
  } else {
    emit("Scanning floor (single pass)…");
    contribs = [];
    let skipped = 0;   // STAT-skip oversized before reading (memory-safe) — a minified bundle never becomes a string
    for (const { rel, text } of walkFiles(repo, skipDirs, scannableForKeys, { maxBytes: COUPLING.maxScanBytes, onSkip: () => skipped++ }))
      contribs.push({ rel, data: scanFloorFile(rel, text) });
    if (skipped) emit(`floor: ${skipped} oversized file(s) skipped (>${Math.round(COUPLING.maxScanBytes / 1e6)}MB; raise/disable via SEAM_MAX_SCAN_BYTES)`);
  }
  ctx.floorContribs.set(repo, contribs);
  return contribs;
}

function build_floor_indices(repo: string, skipDirs: Set<string>, ctx: EngineCtx): void {
  if (ctx.sharedKey.has(repo) && ctx.paramKeys.has(repo)) return;
  const { shared, param } = mergeFloor(floorContributions(repo, skipDirs, ctx));
  ctx.sharedKey.set(repo, shared);
  ctx.paramKeys.set(repo, param);
  ctx.floorBase.set(repo, mergeGrounding(shared, param));   // merge ONCE here, not per resolveCoupling call
}

export function shared_key_index(repo: string, skipDirs: Set<string>, ctx: EngineCtx): GroundingIndex {
  if (!ctx.sharedKey.has(repo)) build_floor_indices(repo, skipDirs, ctx);
  return ctx.sharedKey.get(repo)!;
}

// The constant-resolved param-key grounding — built in the SAME single pass as shared_key_index.
export function param_key_index(repo: string, skipDirs: Set<string>, ctx: EngineCtx): GroundingIndex {
  if (!ctx.paramKeys.has(repo)) build_floor_indices(repo, skipDirs, ctx);
  return ctx.paramKeys.get(repo)!;
}

// The MERGED deterministic floor (shared-key ⊕ const-resolved param) — cached, so the merge cost is paid
// ONCE per repo/run, not re-done on every per-node resolveCoupling call.
export function floor_base_index(repo: string, skipDirs: Set<string>, ctx: EngineCtx): GroundingIndex {
  if (!ctx.floorBase.has(repo)) build_floor_indices(repo, skipDirs, ctx);
  return ctx.floorBase.get(repo)!;
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

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// TARGETED COUPLING (for the BRIDGE / review-impact). resolveCoupling builds a FULL-repo key index (scan
// EVERY file) to ground ANY anchor's keys — right for a multi-node grow that amortises it, WRONG for a
// one-shot review where we already know the anchor's keys. Here we INVERT it (Brice's "grow from the diff"):
// compute the anchor's keys LOCALLY, then for each value GREP the repo for that exact string → only the
// files that could share it, scan THOSE for the complementary key, ground. O(files that mention the key),
// not O(repo) — fast even cold, no full floor index, no `.seam` warm-up. An anchor with NO key returns []
// instantly (the common perf/bugfix case), so the bridge pays ~nothing for a change that touches no boundary.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

export interface CouplingOtherSide { kind: string; value: string; file: string; symbol: string; edgeKind: string; provenance: string }

// Files containing `value` literally — ripgrep (gitignore-aware, instant) with a walk+substring fallback. The
// value is a plausible key (identifier/path), matched as a FIXED string, so there's no regex/shell hazard.
function grepFiles(repo: string, value: string): string[] {
  try {
    const r = spawnSync("rg", ["-l", "-F", "--no-messages", "--", value, "."], { cwd: repo, encoding: "utf-8", maxBuffer: 1 << 27 });
    if (r.status === 0 && r.stdout) return r.stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
    if (r.status === 1) return [];   // ripgrep ran, no matches
  } catch { /* rg absent → fallback */ }
  const out: string[] = [];          // fallback: read+includes (no masking/adapters → far cheaper than the floor scan)
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, scannableForKeys)) if (text.includes(value)) out.push(rel);
  return out;
}

const _TARGETED_CAND_CAP = 200;   // bound the candidate scan for a hot value (a common table name); the relevance floor dampens the rest

// The OTHER SIDE of each coupling the anchor SYMBOL touches — resolved by targeted value-grep, not a full
// index. `available()`-gated (needs tree-sitter for the span + complement unit). Degrades to [] on any miss.
export async function couplingOtherSides(
  repo: string, anchorFile: string, symbol: string,
  opts: { llm?: boolean; model?: string; claudeBin?: string | null } = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<CouplingOtherSide[]> {
  if (!available()) return [];
  let anchorText: string;
  try { anchorText = readFileSync(join(repo, anchorFile), "utf-8"); } catch { return []; }

  // the symbol's span (lo..hi) — scope the anchor keys to the changed symbol, not the whole file.
  let lo = 0, hi = Number.MAX_SAFE_INTEGER;
  const lang = lang_for(anchorFile);
  if (lang) {
    const actx = await makeCtx(anchorText, lang);
    if (actx) for (const n of actx.collect(actx.root, (k) => _FUNCLIKE.has(k) || _CLASS_KINDS.has(k))) {
      if (_name_of(actx, n) === symbol) { [lo, hi] = actx.span(n); break; }
    }
  }
  const inSpan = (line: number) => line >= lo && line <= hi;

  // 1. ANCHOR KEYS — local only (floor + learned matchers + LLM-proposed), span-filtered + deduped.
  const matchers = listMatchers(repo).map((x) => x.matcher);
  // The file's full key scan (floor + matchers) is the same for every symbol IN that file — cache it on the
  // ctx so a multi-symbol bridge run scans each file ONCE, not once per changed symbol (the measured redundancy).
  let fileKeys = ctx.fileKeyScan.get(anchorFile);
  if (!fileKeys) {
    fileKeys = scan_file_keys(anchorFile, anchorText).slice();
    for (const m of matchers) for (const h of await runMatcher(m, anchorFile, anchorText)) fileKeys.push(h);
    ctx.fileKeyScan.set(anchorFile, fileKeys);
  }
  const anchorKeys = new Map<string, { kind: string; value: string; produces: boolean }>();
  const addKey = (h: KeyHit) => { if (inSpan(h.line) && plausibleKeyValue(h.value)) anchorKeys.set(`${h.kind} ${h.value} ${h.produces}`, { kind: h.kind, value: h.value, produces: h.produces }); };
  for (const h of fileKeys) addKey(h);
  if (opts.llm) { const lk = await import("./llm_key_index.js"); for (const h of await lk.anchorProposedKeys(repo, anchorFile, anchorText, { llm: true, model: opts.model, claudeBin: opts.claudeBin }, ctx)) addKey({ ...h, line: lo }); }
  if (!anchorKeys.size) return [];   // no boundary in the anchor → nothing to resolve, instantly

  // 2-4. per key: GREP for the value → candidate files → scan for the COMPLEMENTARY key → ground.
  const anchorNorm = normpath(anchorFile);
  const out: CouplingOtherSide[] = [];
  const seen = new Set<string>();
  for (const key of anchorKeys.values()) {
    const candidates = grepFiles(repo, key.value).filter((f) => normpath(f) !== anchorNorm && scannableForKeys(f)).slice(0, _TARGETED_CAND_CAP);
    let materialised = 0;
    for (const cand of candidates) {
      if (materialised >= READER_CAP) break;
      let text: string; try { text = readFileSync(join(repo, cand), "utf-8"); } catch { continue; }
      const candKeys: KeyHit[] = scan_file_keys(cand, text);
      for (const m of matchers) for (const h of await runMatcher(m, cand, text)) candKeys.push(h);
      const match = candKeys.find((h) => h.kind === key.kind && h.value === key.value && h.produces !== key.produces);   // the COMPLEMENTARY role on the same key
      if (!match) continue;
      const unit = await complement_unit(repo, cand, match.line);
      const dedup = `${cand}#${unit.symbol}#${key.kind} ${key.value}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      materialised++;
      const adapter = kindOf(key.kind);
      out.push({ kind: key.kind, value: key.value, file: cand, symbol: unit.symbol,
        edgeKind: match.produces ? adapter.produceEdge : adapter.consumeEdge, provenance: "RESOLVED_PARTIAL" });
    }
  }
  return out;
}

const CHAIN_DEPTH = COUPLING.chainDepth;   // chain the data-flow boundary this many hops past the anchor (db-table reader → ITS http-route)

// The coupling sub-graph runPipeline builds, as ONE mutable accumulator threaded through the chain recursion
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
  result(): { nodes: any[]; edges: any[]; blindspots: any[]; counter: number } {
    return { nodes: this.nodes, edges: this.edges, blindspots: this.blindspots, counter: this.counter };
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// STEP 1 (assemble half) — SOURCE: gather the EXPENSIVE, repo-wide sources ONCE per anchor before the
// pipeline runs: the carrier-channel index + accesses (Ruby) and the LLM key index + proposed keys. Both
// are cached on EngineCtx (built once per repo/grow), so they're resolved here at the entrypoint, NOT
// re-fetched per node or per chained hop. The cheap scan-adapter floor runs inline inside collectAnchorKeys.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

// PUBLIC per-anchor ENTRYPOINT — resolve the data-coupling boundary for an anchor span and return a DELTA
// (nodes/edges/blindspots + the advanced id counter) for the caller to merge into its graph. Coupling owns
// its OWN grounding here: the Ruby carrier-channel (teacher 1/2/3, homemade data-file coupling) PLUS the
// language-agnostic LLM key index (the framework-AGNOSTIC grounding for floor-blind files) PLUS the
// anchor's proposed keys. So a caller never orchestrates coupling internals nor hands coupling its arrays.
// Self-gates to a no-op delta when data-coupling is off; the grounding self-gates to zero cost without
// `--data-coupling llm` or a prior `.seam/` cache. (Was scan/import_scan `_carrier_extra` + a direct call.)
export interface CouplingOpts { dataCoupling?: boolean; llm?: boolean; model?: string; claudeBin?: string | null }
type _LlmOpts = Pick<CouplingOpts, 'llm' | 'model' | 'claudeBin'>;

// STEP 1 (assemble) — the expensive sources for `resolveCoupling`: the repo-wide LLM key index + the
// anchor's LLM proposed keys (in parallel), and for Ruby the carrier-channel index + carrier accesses;
// the two repo-wide indexes are merged into one groundingIndex. `accesses`/`proposed` are anchor-only.
interface AssembledSources { carrierAccesses?: KeyHit[]; groundingIndex?: GroundingIndex; proposedKeys?: KeyHit[] }
async function assembleSources(
  repo: string, anchorFile: string, anchorText: string, lo: number, hi: number,
  llmOpts: _LlmOpts, ctx: EngineCtx,
): Promise<AssembledSources> {

  const lk = await import("./llm_key_index.js");
  const { module_scope } = await import("../../core/resolve/languages/index.js");
  const scope = module_scope(repo, anchorFile);   // bound the per-file LLM synthesis to the anchor's module (lazy, per-module warm)
  const [llmKeyIndex, proposedKeys] = await Promise.all([
    lk.llmKeyIndex(repo, { ...llmOpts, scope }, ctx),
    lk.anchorProposedKeys(repo, anchorFile, anchorText, llmOpts, ctx),
  ]);

  if (!anchorFile.endsWith(".rb") && !anchorFile.endsWith(".rake")) {
    return { groundingIndex: llmKeyIndex.size ? llmKeyIndex : undefined, proposedKeys };
  }

  const { resolveAnchorCarrier } = await import("./carrier/engine.js");
  const { index: carrierIndex, accesses: carrierAccesses } = await resolveAnchorCarrier(repo, anchorFile, anchorText, lo, hi, llmOpts, ctx);

  const merged = mergeGrounding(llmKeyIndex.size ? llmKeyIndex : undefined, carrierIndex);
  return {
    carrierAccesses,
    groundingIndex: merged.size ? merged : undefined,   // empty → undefined, so resolveCoupling keeps the cached base index (no copy)
    proposedKeys,
  };
}

// PUBLIC per-anchor ENTRYPOINT, as a TWO-PHASE pipeline:
//   STEP 1 (assemble)  — gather the expensive repo-wide sources ONCE (assembleSources)
//   build the STEP-3 grounding index ONCE (scan floor ⊕ the assembled carrier/LLM grounding)
//   STEPS 2-5          — run the recursive per-node pipeline from the anchor (runPipeline)
// Returns the graph delta. The expensive half can't live inside the recursion (a chained hop must reuse
// the index, never re-assemble), which is why phase 1 sits out here and runPipeline is the recursive body.
export async function resolveCoupling(
  repo: string, anchorId: string, anchorFile: string, anchorText: string, lo: number, hi: number,
  counter: number, opts: CouplingOpts = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<{ nodes: any[]; edges: any[]; blindspots: any[]; counter: number }> {

  const graph = new CouplingGraph(counter);
  if (opts.dataCoupling === false) return graph.result();

  const _dct = (label: string, t0: number) => { if (timingOn()) process.stderr.write(`[dc-timing] ${label} ${Math.round(performance.now() - t0)}ms\n`); };
  let _t = performance.now();
  const llmOpts = { llm: opts.llm, model: opts.model, claudeBin: opts.claudeBin };

  // LOCAL GATE — the repo-wide grounding build (the floor scan over EVERY file, the param + LLM key indices)
  // only earns its keep when the ANCHOR'S OWN span touches a coupling boundary: only then is there an "other
  // side" to find. Probe the anchor LOCALLY first — the floor + learned matchers (no repo walk), plus, in LLM
  // mode, the anchor-only proposed keys (one cached anchor-local call assembleSources would make anyway). No
  // key here ⇒ no coupling involves the anchor ⇒ skip the whole repo-wide pass. This is "grow from the diff":
  // a perf/bugfix touching no DB/route/queue/event access pays ~nothing instead of a full-repo scan for a
  // guaranteed-empty result. (Ruby is exempt — its carrier coupling isn't a span-local key; keep the full path.)
  const isRubyAnchor = anchorFile.endsWith(".rb") || anchorFile.endsWith(".rake");
  if (!isRubyAnchor) {
    const inSpan = (line: number) => line >= lo && line <= hi;
    let touchesBoundary = scan_file_keys(anchorFile, anchorText).some((h) => inSpan(h.line));
    if (!touchesBoundary) {   // param/const coupling sites (getParameter(CONST)/addParameter(CONST)) — a DIFFERENT
      const sites: ParamSite[] = [];   // local source than the floor adapters; the value resolves repo-wide but the SITE is local
      scanParamSites(anchorText, anchorFile, sites);
      touchesBoundary = sites.some((s) => inSpan(s.line));
    }
    if (!touchesBoundary) {
      for (const { matcher } of listMatchers(repo)) {
        if ((await runMatcher(matcher, anchorFile, anchorText)).some((h) => inSpan(h.line))) { touchesBoundary = true; break; }
      }
    }
    if (!touchesBoundary && opts.llm) {
      const lk = await import("./llm_key_index.js");
      touchesBoundary = (await lk.anchorProposedKeys(repo, anchorFile, anchorText, llmOpts, ctx)).length > 0;
    }
    if (!touchesBoundary) { _dct("gate: anchor touches no boundary → skipped repo-wide coupling", _t); return graph.result(); }
  }

  const sources = await assembleSources(repo, anchorFile, anchorText, lo, hi, llmOpts, ctx);
  if (!available()) return graph.result();   // no tree-sitter → can't resolve boundary/complement units
  _dct("assemble", _t); _t = performance.now();

  // STEP 3 index, built once: the repo-wide scan floor extended with the const-resolved param floor and the
  // assembled carrier+LLM grounding. `paramIndex` is also threaded raw so each node can re-derive its OWN
  // const-resolved param keys (the per-file scan in collectAnchorKeys doesn't const-resolve — see runPipeline).
  const paramIndex = param_key_index(repo, SKIP_DIRS, ctx);   // cached; threaded raw for paramKeysForSpan
  const base = floor_base_index(repo, SKIP_DIRS, ctx);        // cached merge (shared⊕param) — built once, not per node
  // Only re-merge when there's per-anchor LLM grounding to fold in; the det floor path reuses `base` as-is.
  const index = sources.groundingIndex ? mergeGrounding(base, sources.groundingIndex) : base;
  _dct("index-build", _t); _t = performance.now();
  const stats: DcStats = { nodes: 0, parses: 0, parseMs: 0, ranks: 0, rankMs: 0 };
  // LEARNED adapter rules (cached `.seam/`), deduped — run per-node below to SURFACE keys a built-in adapter
  // no longer covers (e.g. AngularJS $scope bindings, now learned). Pure read (no ledger side-effect).
  const _seen = new Set<string>();
  const matchers = listMatchers(repo).map((x) => x.matcher).filter((m) => { const k = matcherKey(m); return _seen.has(k) ? false : (_seen.add(k), true); });
  const p: PipelineCtx = { graph, repo, index, paramIndex, ctx, stats, matchers };

  await runPipeline(p, { id: anchorId, file: anchorFile, text: anchorText, lo, hi },
    CHAIN_DEPTH, new Set(), sources.carrierAccesses ?? [], sources.proposedKeys ?? []);
  _dct("pipeline(attach)", _t);
  if (timingOn()) process.stderr.write(`[dc-timing] pipeline breakdown: ${stats.nodes} nodes · ${stats.parses} complement parses ${Math.round(stats.parseMs)}ms · ${stats.ranks} key-ranks ${Math.round(stats.rankMs)}ms\n`);

  return graph.result();
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// STEP 1 (inline half) + STEP 2 — KEY: read the cheap scan floor INLINE, then dedupe it with the carrier +
// LLM sources assembled up-front (above) into the keys the span touches, each tagged with the KeySource
// that found it. The tag (not a boolean) drives step 4's blindspot gate: an ungrounded "scan"/"carrier"
// floor key is silently dropped, an ungrounded "llm" proposal is surfaced for review.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

// Collect the keys the anchor body touches, from three sources, deduped (earliest located line wins):
//   1. the deterministic per-file scan (framework adapters)          → source "scan"     ┐ the deterministic
//   2. carrier-channel accesses (Ruby homemade data-file wrappers)   → source "carrier"  ┘ FLOOR (isFloor)
//   3. LLM-proposed keys — kept only where the floor didn't already cover them → source "llm"
// e.g. a `Payment.create(...)` write in the span → AnchorKey{ kind:"db-table", value:"payments", produces:true, source:"scan" }.
function collectAnchorKeys(
  anchorFile: string, anchorText: string, spanLo: number, spanHi: number,
  carrierAccs: KeyHit[], proposed: KeyHit[],
): Map<string, AnchorKey> {
  const anchorKeys = new Map<string, AnchorKey>();
  const accessId = (k: KeyHit) => `${k.kind} ${k.value} ${k.produces}`;
  // 1+2: the located FLOOR (scan + carrier) — span-filtered, earliest line wins, tagged by source
  const addFloor = (hit: KeyHit, source: KeySource) => {
    if (hit.line < spanLo || hit.line > spanHi) return;
    const id = accessId(hit);
    if (!anchorKeys.has(id) || hit.line < anchorKeys.get(id)!.line)
      anchorKeys.set(id, { kind: hit.kind, value: hit.value, produces: hit.produces, line: hit.line, source });
  };
  for (const hit of scan_file_keys(anchorFile, anchorText)) addFloor(hit, "scan");
  for (const hit of carrierAccs) addFloor(hit, "carrier");
  // 3: LLM proposals — not precisely located, anchored at the span start, only where the floor missed them
  for (const proposedKey of proposed) {
    const id = accessId(proposedKey);
    if (!anchorKeys.has(id))
      anchorKeys.set(id, { kind: proposedKey.kind, value: proposedKey.value, produces: proposedKey.produces, line: spanLo, source: "llm" });
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
  anchorKeys: Iterable<AnchorKey>, index: GroundingIndex, anchorPath: string,
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
function collectComplementFiles(index: GroundingIndex, key: AnchorKey, anchorPath: string): Map<string, number> {
  const complementFiles = new Map<string, number>();
  for (const access of otherSide(index, key.kind, key.value, key.produces)) {
    if (normpath(access.file) === anchorPath) continue;
    if (!complementFiles.has(access.file) || access.line < complementFiles.get(access.file)!) complementFiles.set(access.file, access.line);
  }
  return complementFiles;
}

// The RECURSION-WIDE context: the graph accumulator + the STEP-3 grounding index, shared by every chained
// hop. Built ONCE in resolveCoupling; runPipeline + crossBoundary thread it instead of re-passing
// graph/repo/index/ctx through a dozen positional args (the old 12-arg `attach`).
interface PipelineCtx {
  graph: CouplingGraph;
  repo: string;
  index: GroundingIndex;   // STEP 3: repo-wide scan floor ⊕ the assembled carrier+LLM grounding (read-only)
  paramIndex: GroundingIndex;   // const-resolved param grounding, raw — so each node re-derives its own param keys
  ctx: EngineCtx;
  stats: DcStats;          // per-resolveCoupling cost counters (visibility, not behaviour) — see resolveCoupling
  matchers: KeyMatcher[];  // LEARNED adapter rules (cached `.seam/`), run per-node to SURFACE keys like the floor (see runPipeline)
}
// Where the data-coupling crossing actually spends its time. Threaded so the recursion accumulates into one
// object; printed once (--verbose) at the end of the pipeline so a slow grow's cost is a fact, not a guess.
type DcStats = { nodes: number; parses: number; parseMs: number; ranks: number; rankMs: number };
// One node the pipeline runs over: the anchor span first, then each chained complement.
interface PipelineNode { id: string; file: string; text: string; lo: number; hi: number }
// PipelineCtx + the per-node working state (ranking + chain depth), for the step-4/5 helpers below.
interface NodeScope extends PipelineCtx { anchorPath: string; coOccurrence: Map<string, number>; depth: number }

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// STEPS 2-5 — THE PIPELINE: runPipeline runs one node (the anchor, then each chained complement) through
// collect (1-inline + 2) → ground-lookup (3) → draw boundary (4) → wire near + cross far (5). Step 5's
// far side recurses back into runPipeline one hop, so the body is the recursive spine.
// ════════════════════════════════════════════════════════════════════════════════════════════════════

// STEP 4 — DRAW: get-or-mint the synthetic boundary node standing for a key (ONE per kind+value, even when
// the node both produces and consumes it). Anchored at `file` (the current node's file).
function drawBoundary(s: NodeScope, boundaryByKey: Map<string, string>, key: AnchorKey, file: string): string {
  const id = keyId(key.kind, key.value);
  let boundaryId = boundaryByKey.get(id);
  if (boundaryId === undefined) {
    boundaryId = s.graph.addNode({ symbol: key.value, kind: kindOf(key.kind).nodeKind, file, range: [key.line, key.line], enclosing: "", complexity: 1, coupling: true });
    boundaryByKey.set(id, boundaryId);
  }
  return boundaryId;
}

// STEP 5 (near) — WIRE the current node to its boundary with the produce/consume crossing.
function wireNear(s: NodeScope, fromId: string, boundaryId: string, key: AnchorKey): void {
  const adapter = kindOf(key.kind);
  s.graph.addEdge({ from: fromId, to: boundaryId, kind: key.produces ? adapter.produceEdge : adapter.consumeEdge, provenance: "RESOLVED_PARTIAL", line: key.line });
}

// An LLM-proposed key the deterministic index couldn't ground → a blindspot, not a materialised node. A
// floor (scan/carrier) key that doesn't ground is silently dropped (no proposal to surface).
function reportUngroundedKey(s: NodeScope, nodeId: string, key: AnchorKey): void {
  if (isFloor(key)) return;
  s.graph.addBlindspot({ node: nodeId, mechanism: "llm-proposed-key",
    evidence: `LLM proposes a ${key.kind} coupling on '${key.value}' (${key.produces ? "produced" : "consumed"} here) the deterministic scan didn't index`, candidates: [] });
}

// STEP 5 (far) — CROSS the boundary: rank this key's complement files, materialise the top READER_CAP as
// nodes with boundary→complement crossings, CHAIN one hop into each (re-entering runPipeline), and record
// the over-cap tail as a fanout blindspot. `surfacedKeys` already carries this boundary's key, so the
// chain can't loop back in.
async function crossBoundary(
  s: NodeScope, boundaryId: string, key: AnchorKey, complementFiles: Map<string, number>, surfacedKeys: Set<string>,
): Promise<void> {
  const { graph, repo, depth, coOccurrence, ctx } = s;
  const adapter = kindOf(key.kind);
  const complementProduces = !key.produces;
  const rankedComplements = orderComplementsByRelevance(complementFiles, coOccurrence);
  for (const [file, line] of rankedComplements.slice(0, READER_CAP)) {
    // GROW-WIDE FANOUT BUDGET: each complement is a tree-sitter parse (the data-coupling bottleneck). A hub
    // key/anchor fans out to hundreds — bound the TOTAL across the whole grow so a central anchor can't run
    // for ages. When exhausted, stop materialising (the over-budget tail is recorded as a fanout blindspot).
    if (ctx.complementBudget <= 0) break;
    ctx.complementBudget--;
    const _pt0 = performance.now();
    const unit = await complement_unit(repo, file, line);
    s.stats.parses++; s.stats.parseMs += performance.now() - _pt0;
    if (s.stats.parses % 25 === 0) emit(`data-coupling: materialized ${s.stats.parses} complements (${ctx.complementBudget} of the fanout budget left)…`);
    const edgeKind = complementProduces ? adapter.produceEdge : adapter.consumeEdge;
    // A complement reached across a HANDLER edge (a route/call server entry) is a downstream-mechanism node:
    // tag it "backward" so the grow expands it DOWNSTREAM (into the @Inject'd bean it delegates to) — its
    // in-repo callers are just the framework. Data-boundary complements stay untagged → upstream (display).
    const direction = edgeKind === adapter.handlerEdge ? "backward" : undefined;
    const complementId = graph.addNode({ symbol: unit.symbol, kind: unit.kind, file, range: [unit.start, unit.end], enclosing: "", complexity: Math.max(1, unit.end - unit.start + 1), coupling: true, ...(direction ? { direction } : {}) });
    graph.addEdge({ from: boundaryId, to: complementId, kind: edgeKind, provenance: "RESOLVED_PARTIAL" });
    // CHAIN: this complement may itself sit on the next boundary (the route handler that SERVES what the UI
    // fetches). Recurse one hop into its body, scanning ITS keys — `surfacedKeys` blocks the table it reads.
    if (depth > 0) {
      let complementText = "";
      try { complementText = readFileSync(join(repo, file), "utf-8"); } catch { /* unreadable complement → no chain */ }
      if (complementText) await runPipeline(s, { id: complementId, file, text: complementText, lo: unit.start, hi: unit.end }, depth - 1, surfacedKeys);
    }
  }
  if (rankedComplements.length > READER_CAP) {
    graph.addBlindspot({ node: boundaryId, mechanism: "shared-key-fanout",
      evidence: `'${key.value}' (${key.kind}) is ${complementProduces ? "written" : "read"} in ${rankedComplements.length} files (showing ${READER_CAP}) — a data-flow boundary, not a call`,
      candidates: rankedComplements.slice(READER_CAP).map(([file]) => ({ file, symbol: key.value, provenance: "SUGGESTED" })) });
  }
}

// THE PER-NODE PIPELINE BODY — run one span (the anchor, or a chained complement) through steps 1-inline..5
// and append the boundaries it surfaces to the shared graph. For each key it PRODUCES surface the consumers,
// for each it CONSUMES surface the producers. `carrierAccs`/`proposed` are ANCHOR-only (empty on every hop);
// the recursion threads the same PipelineCtx (`p`) so the index/graph are never rebuilt. No keys → no-op.
async function runPipeline(
  p: PipelineCtx, node: PipelineNode, depth: number, seenKeys: Set<string>,
  carrierAccs: KeyHit[] = [], proposed: KeyHit[] = [],
): Promise<void> {
  p.stats.nodes++;
  // STEP 1 (inline scan) + STEP 2 — the keys this span touches, tagged by source
  const keys = collectAnchorKeys(node.file, node.text, node.lo, node.hi, carrierAccs, proposed);
  // STEP 1b — the node's const-resolved param keys, read back from the repo param index (the per-file scan
  // above can't resolve `getParameter(TOKEN_KEY)` → "token"). Floor source, so an ungrounded one is dropped.
  for (const hit of paramKeysForSpan(p.paramIndex, node.file, node.lo, node.hi)) {
    const id = `${hit.kind} ${hit.value} ${hit.produces}`;
    if (!keys.has(id) || hit.line < keys.get(id)!.line) keys.set(id, { ...hit, source: "scan" });
  }
  // STEP 1c — LEARNED adapter rules applied to THIS span, exactly like the floor scan (span-filtered, earliest
  // line wins). This is what lets a learned rule (a framework Seam has no built-in adapter for — AngularJS
  // $scope, a custom event bus) surface a node's OWN keys so it can cross on them, not just feed the index.
  for (const m of p.matchers) for (const hit of await runMatcher(m, node.file, node.text)) {
    if (hit.line < node.lo || hit.line > node.hi) continue;            // span-local, like scan_file_keys
    const id = `${hit.kind} ${hit.value} ${hit.produces}`;
    if (!keys.has(id) || hit.line < keys.get(id)!.line) keys.set(id, { kind: hit.kind, value: hit.value, produces: hit.produces, line: hit.line, source: "scan" });
  }
  // DIAGNOSTIC (--verbose, or the narrow SEAM_COUPLING_DEBUG): why did a node surface (or fail to surface)
  // couplings? Prints every key this span touches, its source, and how many files sit on the OTHER side
  // (0 = ungrounded → dropped).
  if (verbose() || process.env.SEAM_COUPLING_DEBUG) {
    const anchorPath0 = normpath(node.file);
    const rows = [...keys.values()].map((k) => `${k.kind} '${k.value}' (${k.produces ? "produces" : "consumes"}, ${k.source}) → ${collectComplementFiles(p.index, k, anchorPath0).size} other-side file(s)`);
    process.stderr.write(`[coupling-debug] ${node.file}:${node.lo} surfaced ${keys.size} key(s):\n${rows.map((r) => "    " + r).join("\n") || "    (none)"}\n`);
  }
  if (!keys.size) return;

  // STEP 3 (rank) — score each candidate complement once, for the capped fan
  const anchorPath = normpath(node.file);
  const s: NodeScope = { ...p, anchorPath, coOccurrence: rankComplementsByCoOccurrence(keys.values(), p.index, anchorPath), depth };

  const boundaryByKey = new Map<string, string>();   // key identity → boundary node id (one per key)
  const surfacedKeys = new Set(seenKeys);            // ancestor keys + the ones THIS node surfaces (fed to the chain)

  // STEP 3 (lookup) — gather each grounded key with its other-side files (ungrounded floor keys dropped here).
  const grounded: { key: AnchorKey; complementFiles: Map<string, number> }[] = [];
  for (const key of keys.values()) {
    if (seenKeys.has(keyId(key.kind, key.value))) continue;   // an ancestor already surfaced this boundary — don't loop back
    const complementFiles = collectComplementFiles(p.index, key, anchorPath);
    if (!complementFiles.size) { reportUngroundedKey(s, node.id, key); continue; }
    grounded.push({ key, complementFiles });
  }
  // PER-NODE FAN CAP — a HUB node (a big component emitting dozens of UI events: `input`/`click`/…) surfaces
  // many keys, each fanning to many files → the coupling explodes (the slow big-file case). We keep `cap` keys
  // and demote the rest to ONE blindspot. ORDER, best-first:
  //   • INTENT-aware (when ctx.rankKeys is set, i.e. an --intent grow with embeddings): most intent-relevant
  //     first — so the demoted/blindspotted keys are the ones LEAST related to the question (inoffensive).
  //   • else DETERMINISTIC fallback: most SPECIFIC first (lowest cross-file fanout = real 1-to-1 couplings),
  //     demoting the high-fanout hub keys (generic events shared by dozens). Both recall-safe (blindspot).
  const cap = Number(process.env.SEAM_NODE_KEY_CAP ?? COUPLING.nodeKeyCap);   // runtime-tunable (per-run)
  const byFanout = (a: typeof grounded[number], b: typeof grounded[number]) =>
    (a.complementFiles.size - b.complementFiles.size) || (a.key.value < b.key.value ? -1 : a.key.value > b.key.value ? 1 : 0);
  if (grounded.length > cap && s.ctx.rankKeys) {
    // intent-rank from the key VALUE, its OTHER SIDE (complement file paths — known without materializing),
    // and the local PASSAGE (a few lines around the key's use here). MAX over signals → keep if any relevant.
    const lines = node.text.split("\n");
    const passageAt = (ln: number) => lines.slice(Math.max(0, ln - 3), ln + 4).join("\n").slice(0, 600);
    const items = grounded.map((g) => ({ value: g.key.value, otherSide: [...g.complementFiles.keys()], passage: passageAt(g.key.line) }));
    const _rt0 = performance.now();
    const rel = await s.ctx.rankKeys(items).catch(() => new Map<string, number>());
    const _rdt = performance.now() - _rt0; s.stats.ranks++; s.stats.rankMs += _rdt;
    if (timingOn()) process.stderr.write(`[dc-timing] key-rank ${node.file}:${node.lo} ${items.length} keys ${Math.round(_rdt)}ms\n`);
    if (rel.size) grounded.sort((a, b) => ((rel.get(b.key.value) ?? 0) - (rel.get(a.key.value) ?? 0)) || byFanout(a, b));   // most intent-relevant first
    else grounded.sort(byFanout);
  } else {
    grounded.sort(byFanout);
  }
  // mark the DEMOTED keys seen FIRST, so the chain (crossBoundary's recursion) doesn't re-surface them
  // through a complement — keeping the hub's fan genuinely bounded, not just deferred one hop.
  for (const { key } of grounded.slice(cap)) surfacedKeys.add(keyId(key.kind, key.value));
  for (const { key, complementFiles } of grounded.slice(0, cap)) {
    const boundaryId = drawBoundary(s, boundaryByKey, key, node.file);   // STEP 4
    surfacedKeys.add(keyId(key.kind, key.value));                        // mark before recursing
    wireNear(s, node.id, boundaryId, key);                              // STEP 5 (near)
    await crossBoundary(s, boundaryId, key, complementFiles, surfacedKeys);   // STEP 5 (far) + chain
  }
  if (grounded.length > cap) s.graph.addBlindspot({ node: node.id, mechanism: "node-key-fanout",
    evidence: `${node.file} touches ${grounded.length} shared keys (showing the ${cap} most specific) — a coupling hub`,
    candidates: grounded.slice(cap).map((g) => ({ file: node.file, symbol: g.key.value, provenance: "SUGGESTED" as const })) });
}
