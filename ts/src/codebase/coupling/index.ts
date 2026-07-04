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
import { type Ctx, makeCtx, available, lang_for, _FUNCLIKE, _CLASS_KINDS, _METHOD_KINDS, _NAME_KINDS, _NAME_LEAVES } from "../atoms.js";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { normpath, walkFiles } from "../../core/resolve/walk.js";
import { type Access, type KeyHit, type AnchorKey, type KeySource, type GroundingIndex, type CouplingNode, type Crossing, type Blindspot, isFloor } from "./types.js";
import { EngineCtx } from "../engine_ctx.js";
import { ADAPTERS, allAdapters, ADAPTERS_VERSION, kindOf, scan_file_keys, scannableForKeys, KEY_EDGE_KINDS, HANDLER_EDGE_KINDS, KEY_NODE_KINDS, KEY_PRODUCE_EDGE_KINDS, DOMAIN_SUBJECT_KINDS } from "./adapters/index.js";
import { type KeyMatcher, matcherKey, runMatcher, plausibleKeyValue } from "./key_ir.js";
import { inferHttpClients, httpClientMatchers, resolveHttpCallSites } from "./effect_inference.js";
import { getOrSet } from "../engine_ctx.js";
import { listMatchers } from "./key_store.js";
import { scanConstDecls, scanParamSites, resolveParamSites, paramKeysForSpan, type ParamSite } from "./const_keys.js";
import { makeMaskCtx } from "./adapters/util.js";
import { indexCacheEnabled, incrementalScan } from "./index_cache.js";
import { COUPLING } from "./config.js";
import { emit, verbose, timingOn, dbg } from "../../core/progress.js";

export type { KeyHit, KeyKind, Access, AnchorKey, KeySource, GroundingIndex } from "./types.js";
export { ADAPTERS, scan_file_keys, scannableForKeys } from "./adapters/index.js";

// Classification predicates — the data-coupling VOCABULARY exposed as BEHAVIOUR, not raw kind Sets.
// Consumers (the grow loop, the seam assembler) ask coupling "is this edge a crossing? this node a flow
// subject? this a produce-edge?" instead of importing the Sets, so coupling's representation stays private.
export const isCouplingCrossing = (edgeKind: string): boolean => KEY_EDGE_KINDS.has(edgeKind);
export const isHandlerEdge = (edgeKind: string): boolean => HANDLER_EDGE_KINDS.has(edgeKind);   // points AT a cross-stack handler endpoint
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
// A GENERIC 1-literal route match (a bare `/summarize/*` shared by many services) is a coupling ONLY if it
// grounds to at most this many files — a SOLE mount. Above it, the shared segment is a coincidental common word.
const _GENERIC_ROUTE_FANOUT_CAP = 1;
// Route patterns rarely equal a caller URL byte-for-byte: a handler `@WebServlet("/document/*")` is
// mounted under a context path the caller spells in full (`/manage/rest/member/document`). So for
// http-route keys ONLY, couple a handler to a caller when one path's segments are a whole-SEGMENT SUFFIX
// of the other's (after dropping a trailing `/*` wildcard) — whole-segment so `/doc` ≁ `/mydoc`.
const routeSegs = (value: string): string[] => value.split("/").filter(Boolean);   // keep "*" (a path param) as a wildcard segment
const _segEq = (a: string, b: string): boolean => a === b || a === "*" || b === "*";   // a `{param}`/`*` matches any literal segment
// Two route paths COUPLE when the shorter aligns CONTIGUOUSLY inside the longer from a shared anchor segment —
// a param `*` matching any literal — accepting EITHER the shorter as a complete sub-path of the longer (a full-
// URL caller ⇄ a relative handler) OR a caller TRUNCATED by string concatenation, where the overlap ends at the
// longer's boundary (`$http.get("/x/summarize/0/" + id)` loses its tail → `/x/summarize/0`, grounding to
// `@Path("summarize/{page}/{id}")` → `…/summarize/*/*`). A truncated match needs ≥2 contiguous segments so a
// single shared word can't ground unrelated routes. Every crossing it grounds is RESOLVED_PARTIAL (relevance prunes).
// The SPECIFICITY of the best alignment between two routes: the count of LITERAL segments they agree on (a
// `*` param is not distinctive), or -1 when they don't align at all. Alignment = the shorter occurs contiguously
// in the longer (param-aware), either fully consumed or running to the longer's boundary (a concat-truncated
// caller). Used both as the boolean match (≥1 shared literal) AND, in otherSide, to keep only the MOST specific
// match — so a generic `/summarize/*` can't ground a caller that also has a fuller `/…/booking/summarize/*/*`.
export function routeMatchSpecificity(a: string, b: string): number {
  const A = routeSegs(a), B = routeSegs(b);
  if (!A.length || !B.length) return -1;
  const [long, short] = A.length >= B.length ? [A, B] : [B, A];
  let best = -1;
  for (let off = 0; off < long.length; off++) {
    let i = 0, lit = 0;
    while (i < short.length && off + i < long.length && _segEq(long[off + i], short[i])) {
      if (short[i] !== "*" && long[off + i] !== "*") lit++;
      i++;
    }
    if ((i === short.length || off + i === long.length) && i >= 1) best = Math.max(best, lit);
  }
  return best;
}
export function routeSuffixMatch(a: string, b: string): boolean { return routeMatchSpecificity(a, b) >= 1; }
// The OTHER side of an access — its COMPLEMENTS. If the anchor PRODUCES the key we return its consumers;
// if it CONSUMES, we return its producers:
//   produces `payments`  → [report.rb:12, dash.tsx:88]   (the readers)
//   consumes `payments`  → [billing.rb:40]               (the writer)
// This is a one-directional lookup keyed PURELY on the shared key string — there is NO check that the
// complement points back at THIS producer. The only evidence is "both name the same key", which is why
// every coupling edge emitted is RESOLVED_PARTIAL (a shared-name crossing), never an asserted call.
// Exact-key matches, plus (for http-route) suffix-aliased route keys, so a full-URL caller grounds to a
// sub-path/wildcard handler and vice-versa. Dedup is handled downstream (complementFiles).
export function otherSide(index: GroundingIndex, kind: string, value: string, produces: boolean): Access[] {
  const exact = index.get(keyId(kind, value));
  const out: Access[] = [...((produces ? exact?.consumers : exact?.producers) ?? [])];
  if (kind !== _HTTP_ROUTE) return out;
  const prefix = `${_HTTP_ROUTE} `;
  // Score every fuzzy route match by SPECIFICITY (shared literal segments). ALWAYS keep the SPECIFIC matches
  // (≥2 shared literals — a real cross-stack reach), and keep a GENERIC 1-literal fragment (a bare
  // `/summarize/*`, shared by booking AND adviser) ONLY when no specific match exists — so the generic can't
  // ground a caller that also has a fuller match, but a legitimate specific match (or a sole generic, like a
  // `/document/*` servlet mount) is NEVER dropped. (The old "keep only the single best tier" was too
  // aggressive — it could discard a valid multi-literal match whenever anything scored higher.)
  const scored: { spec: number; accesses: Access[] }[] = [];
  for (const [k, v] of index) {
    if (!k.startsWith(prefix)) continue;
    const val = k.slice(prefix.length);
    if (val === value) continue;   // exact already counted
    const spec = routeMatchSpecificity(val, value);
    if (spec >= 1) scored.push({ spec, accesses: produces ? v.consumers : v.producers });
  }
  const hasSpecific = scored.some((s) => s.spec >= 2);
  for (const s of scored) if (s.spec >= 2) out.push(...s.accesses);   // a SPECIFIC (≥2-literal) match is always kept
  if (!hasSpecific) {
    // GENERIC fallback — a single shared literal (a bare `/summarize/*` method-@Path with no combinable class
    // base). A SOLE mount (`/document/*` servlet → one file) is a real coupling: keep it. But when the segment
    // grounds to MANY files it's a coincidental COMMON WORD (`summarize`/`list`, one per service) — keep only the
    // producer whose FILE reflects a DISCRIMINATING segment of the caller route (BookingsService for
    // `/…/booking/summarize`), dropping the unrelated services. If NONE match, DROP them all: a single caller
    // route can't legitimately couple to many DISTINCT services through one shared common word, so an
    // un-discriminable many-file generic is coincidental, not a coupling. (Every disambiguable real coupling is
    // already preserved above — the ≥2-literal SPECIFIC match and the sole-mount generic.) This stops the booking
    // flow dragging in every `summarize` service (CompanyAdviser/Analytics/…) via the bare `/summarize/*` key.
    const generics = scored.filter((s) => s.spec < 2).flatMap((s) => s.accesses);
    const files = new Set(generics.map((a) => a.file));
    if (files.size <= _GENERIC_ROUTE_FANOUT_CAP) { out.push(...generics); return out; }
    const segs = routeSegs(value).filter((x) => x !== "*" && x.length >= 4);
    const disc = generics.filter((a) => segs.some((seg) => a.file.toLowerCase().includes(seg.toLowerCase())));
    out.push(...disc);   // many-file generic, no discriminating filename → coincidental common word → drop all
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
// `alogic` = adapter-LOGIC version: the salt already keys on the adapter SET (kinds), but not on a kind's
// extraction LOGIC. Bump this when an adapter's scan changes (e.g. endpoint_map multi-line descriptors) so a
// cached floor re-scans instead of serving pre-fix keys — otherwise a logic fix is invisible on a warm repo.
const _ADAPTER_LOGIC_VERSION = "2";
function floorConfigSalt(): string {
  return `cap=${COUPLING.maxScanBytes}|noadapt=${process.env.SEAM_NO_ADAPTERS ?? ""}|alogic=${_ADAPTER_LOGIC_VERSION}|adapters=${allAdapters().map((a) => a.kind).join(",")}|plugins=${ADAPTERS_VERSION}`;
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

// The declared NAME of a def — the tree-sitter `name` FIELD first (NOT a leading return type: a Java/C++
// `SubList paginate(...)` writes the type before the name, so a positional scan grabbed `SubList`), then the
// C/C++ declarator-field chain, then a positional fallback. Mirrors scan/ast_units._name_of — duplicated here
// because coupling can't import scan (scan→coupling already exists; importing back would cycle).
function _name_of(ctx: Ctx, node: any): string | null {
  const nf = node.childForFieldName?.("name");
  if (nf) return ctx.text(nf);
  let x: any = node.childForFieldName?.("declarator");
  for (let g = 0; x && g < 16; g++) {
    if (_NAME_LEAVES.has(x.type)) return ctx.text(x);
    x = x.childForFieldName?.("declarator") ?? null;
  }
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
export function grepFiles(repo: string, value: string): string[] {
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
async function _learn(
  repo: string, anchorFile: string, anchorText: string, lo: number, hi: number,
  llmOpts: _LlmOpts, ctx: EngineCtx,
): Promise<AssembledSources> {

  // STABLE-FLOOR pre-grow: the footprint must be computed from the DETERMINISTIC floor ONLY, so the scope is
  // identical run-to-run (else the learned adapters below expand it every run → warm never settles). Return no
  // assembled sources → resolveCoupling uses just floor_base_index (the built-in adapters, incl. member_access).
  if (ctx.stableFloor) return { proposedKeys: [] };
  const lk = await import("./llm_key_index.js");
  const { module_scope } = await import("../../core/resolve/languages/index.js");
  // FOOTPRINT-scoped when a floor pre-grow set ctx.footprintFiles (the flow's files, cross-module); else the
  // anchor's module directory (lazy, per-module warm).
  const scope = module_scope(repo, anchorFile);
  const scopeFiles = ctx.footprintFiles;
  // L3 (the PER-ANCHOR LLM key probe) is DEFAULT-OFF on a footprint grow. anchorProposedKeys is the per-file
  // LLM discovery (`discover-keys-batch`) applied per node. On a footprint grow L2 — the matcher flywheel
  // (llmKeyIndex, footprint-scoped, clustered, cached, deterministic repo-wide) — already covers the couplings,
  // so the per-node L3 probe is the redundant "finds nothing 95% of the time" pass: measured on cal.com (2
  // anchors) it grounded 0–1 UNIQUE couplings (the lone hit a test-scaffolding file) for 37–98s of cold sonnet,
  // and it churned warm (the wave frontier varies run-to-run → never cache-settles). So a footprint grow runs on
  // L1 (floor) + L2 (matcher rules); the per-anchor L3 is OPT-IN via SEAM_ANCHOR_KEYS=1 (for a genuinely
  // cross-stack repo where it might add a real edge), and even then it stays BOUND to ctx.footprintFiles so the
  // opt-in path still warm-caches. NON-footprint single-anchor grows (no scopeFiles) keep L3 unconditionally —
  // there's no footprint-scoped L2 pass there, and implicit-key recall (the regression tests) depends on it.
  const inFootprint = !scopeFiles || scopeFiles.has(anchorFile);
  const probe = !scopeFiles || (process.env.SEAM_ANCHOR_KEYS === "1" && inFootprint);
  const [llmKeyIndex, proposedKeys] = await Promise.all([
    lk.llmKeyIndex(repo, { ...llmOpts, scope, scopeFiles }, ctx),
    probe ? lk.anchorProposedKeys(repo, anchorFile, anchorText, llmOpts, ctx) : Promise.resolve([] as KeyHit[]),
  ]);

  // The CARRIER engine is Ruby's native home (its data-file coupling isn't a span-local key). It is gated to
  // Ruby anchors: enabling it for JS/TS made the carrier walk PARSE every JS file tree-sitter-wide, which on
  // a big repo exhausts the web-tree-sitter WASM heap (the `_astCache` keeps every tree) → an out-of-bounds
  // crash. And it was redundant there: JS/TS cross-stack couplings (a custom Vue.http / DI) are carried by
  // the MATCHER flywheel (llmKeyIndex, above), not the carrier. So keep the carrier Ruby-only.
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

// P3 GATE (perf guard) — the repo-wide grounding build only earns its keep when the ANCHOR's span touches a
// coupling boundary: only then is there an "other side" to find. Probe LOCALLY — floor keys, then param sites,
// then learned matchers (no repo walk), then in LLM mode the anchor's proposed keys. No key ⇒ skip the whole
// repo-wide pass ("grow from the diff": a change touching no DB/route/queue/event pays ~nothing). Returns true
// = PROCEED. Ruby is exempt (carrier coupling isn't span-local) and footprint-scoped is already bounded AND the
// gate is chicken-and-egg cold (the rule that would key the anchor isn't learned yet) — both bypass to true.
// SIGNAL #5 of the L3 trigger — a route/HANDLER file by convention. A RECALL NET (which files are worth the
// per-anchor LLM, NOT a meaning judgement — the structural↔semantic rule): the purest implicit keys (a Rails
// `resources` route, a controller's convention route) have NO key LITERAL to ground a deterministic signal on,
// so the file's handler shape is the only cheap signal it MIGHT carry a deducible boundary. Deliberately broad
// (recall over precision — a false positive is just one extra LLM probe). Extensible across stacks.
export function _handlerShaped(file: string): boolean {
  const segs = file.toLowerCase().split("/");
  if (segs.some((s) => ["controllers", "controller", "handlers", "routes", "endpoints", "resolvers", "webhooks"].includes(s))) return true;
  const base = segs[segs.length - 1];
  return base === "route.ts" || base === "route.js"
    || /(_controller\.rb|controller\.(ts|js|java|kt|cs|php|py)|\.handler\.(ts|js)|_handler\.go|resource\.java)$/.test(base);
}

async function _gateTouchesBoundary(repo: string, anchorFile: string, anchorText: string, lo: number, hi: number, llmOpts: _LlmOpts, opts: CouplingOpts, ctx: EngineCtx): Promise<boolean> {
  if (anchorFile.endsWith(".rb") || anchorFile.endsWith(".rake")) return true;   // carrier (Ruby) coupling isn't span-local
  const footprint = !!ctx.footprintFiles;
  // GROUNDED L3 TRIGGER — a footprint grow used to BYPASS this gate (return true), so the per-anchor LLM
  // (anchorProposedKeys) ran on EVERY coupled node = a per-file LLM sweep that finds nothing 95%+ of the time on
  // a big repo. Now a footprint grow runs the gate too, so L3 fires ONLY where a GROUNDED boundary signal (below)
  // says a key is plausible. SEAM_ANCHOR_KEYS=1 restores the always-probe bypass (a test asserting a signal-less
  // implicit key sets it). Non-footprint is UNCHANGED (it keeps the per-anchor LLM fallback at the end).
  if (footprint && process.env.SEAM_ANCHOR_KEYS === "1") return true;
  const inSpan = (line: number) => line >= lo && line <= hi;
  if (scan_file_keys(anchorFile, anchorText).some((h) => inSpan(h.line))) return true;          // 1 — floor keys
  const sites: ParamSite[] = []; scanParamSites(anchorText, anchorFile, sites);                 // 3 — getParameter(CONST)/addParameter(CONST) sites
  if (sites.some((s) => inSpan(s.line))) return true;
  if (!ctx.stableFloor && resolveHttpCallSites(anchorFile, anchorText, await _effectClients(repo, ctx)).some((h) => inSpan(h.line))) return true;   // 2 — http I/O
  if (_handlerShaped(anchorFile)) return true;                                                  // 5 — route/handler file (the implicit-key recall net)
  if (!ctx.stableFloor) for (const { matcher } of listMatchers(repo)) {   // 4 — learned matchers (not in a stable-floor probe)
    if ((await runMatcher(matcher, anchorFile, anchorText)).some((h) => inSpan(h.line))) return true;
  }
  // LLM fallback — NON-footprint only. A footprint grow must NOT per-node LLM-probe (that's the L3 sweep this
  // trigger exists to prune); it relies on the grounded signals above. Non-footprint keeps the probe (unchanged).
  if (!footprint && opts.llm) {
    const lk = await import("./llm_key_index.js");
    if ((await lk.anchorProposedKeys(repo, anchorFile, anchorText, llmOpts, ctx)).length > 0) return true;
  }
  return false;
}

// P3 CACHE (load) — the LEARNED adapter rules from the `.seam` store (persisted by LEARN, replayed warm = 0
// LLM — the capitalisation). Deduped; empty under a stable-floor probe (learned rules are the accumulating part).
function _loadAdapters(repo: string, ctx: EngineCtx): KeyMatcher[] {
  if (ctx.stableFloor) return [];
  const seen = new Set<string>();
  return listMatchers(repo).map((x) => x.matcher).filter((m) => { const k = matcherKey(m); return seen.has(k) ? false : (seen.add(k), true); });
}

// Effect inference (DETERMINISTIC, no LLM) — the SET of custom http-client receiver tokens deduced transitively
// from grounded fetch/axios sinks, cached per repo on the ctx. Footprint-scoped when a pre-grow set
// ctx.footprintFiles (cheap); else a bounded repo walk (reusing the floor's scannable-file set). Empty under
// stableFloor so the pre-grow footprint stays pure-floor (mirrors _loadAdapters). Drives BOTH the literal-call
// channel matchers (_effectMatchers) and the indirected-call resolver (resolveHttpCallSites in runPipeline).
async function _effectClients(repo: string, ctx: EngineCtx): Promise<Set<string>> {
  if (ctx.stableFloor) return new Set();
  return getOrSet(ctx.httpClients, repo, async () => {
    const scope = ctx.footprintFiles;
    const files: { rel: string; text: string }[] = [];
    for (const { rel, text } of walkFiles(repo, SKIP_DIRS, scannableForKeys, { maxBytes: COUPLING.maxScanBytes })) {
      if (!scope || scope.has(rel)) files.push({ rel, text });
    }
    return inferHttpClients(files);
  });
}

// PUBLIC per-anchor ENTRYPOINT — the P3 coupling pipeline (docs/coupling-strategy.md):
//   GATE    skip the whole pass when the anchor touches no boundary (perf)
//   LEARN   the flywheel — LLM passes synthesise adapter rules + per-file/carrier grounding (persisted: CACHE)
//   FLOOR   deterministic adapters → repo-wide key index (cached, no LLM)
//   GROUND  co-occurrence — one grounding index from FLOOR ∪ LEARN (a key is real only where both sides name it)
//   CACHE   the `.seam` matcher store — LEARN persists, APPLY replays (warm-free) — load the adapters here
//   APPLY   materialise the anchor's cross-boundary bridges from the grounded index + matchers (runPipeline)
// The expensive FLOOR/LEARN/GROUND build sits out here (computed once); APPLY's recursive body reuses the index
// so a chained hop never re-assembles.
export async function resolveCoupling(
  repo: string, anchorId: string, anchorFile: string, anchorText: string, lo: number, hi: number,
  counter: number, opts: CouplingOpts = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<{ nodes: any[]; edges: any[]; blindspots: any[]; counter: number }> {

  const graph = new CouplingGraph(counter);
  if (opts.dataCoupling === false) return graph.result();
  // STAGE diagnostics at --verbose (the FLOOR/LEARN/GROUND/APPLY timing + counts you read to debug coupling);
  // the per-NODE timing firehose stays at --trace (timingOn). TAG the throwaway footprint-scoping probe
  // (`ctx.stableFloor`) so its per-file gating — which sweeps the WHOLE module to discover the flow's files,
  // mostly `→ skipped` — is visibly distinct from the REAL grow's (scoped) coupling and doesn't read as "the
  // grow is following http-routes everywhere". Diagnostic-only; the probe's footprint is discarded.
  const _tag = ctx.stableFloor ? "coupling·probe" : "coupling";
  const _stage = (label: string, t0: number) => dbg(`[${_tag}] ${anchorFile}: ${label} (${Math.round(performance.now() - t0)}ms)`);
  let _t = performance.now();
  const llmOpts = { llm: opts.llm, model: opts.model, claudeBin: opts.claudeBin };

  // GATE
  if (!(await _gateTouchesBoundary(repo, anchorFile, anchorText, lo, hi, llmOpts, opts, ctx))) {
    _stage("GATE: anchor touches no boundary → skipped", _t); return graph.result();
  }

  // LEARN — the flywheel: LLM passes synthesise adapter rules + per-file/carrier grounding; persisted to .seam.
  const learned = await _learn(repo, anchorFile, anchorText, lo, hi, llmOpts, ctx);
  if (!available()) return graph.result();   // no tree-sitter → can't resolve boundary/complement units
  _stage(`LEARN: ${learned.groundingIndex?.size ?? 0} learned key(s)`, _t); _t = performance.now();

  // FLOOR — deterministic adapters → the repo-wide key index (cached). The param floor is threaded raw too, so
  // each node can re-derive its OWN const-resolved param keys (the per-file scan doesn't const-resolve).
  const paramIndex = param_key_index(repo, SKIP_DIRS, ctx);
  const floor = floor_base_index(repo, SKIP_DIRS, ctx);

  // GROUND — one grounding index from FLOOR ∪ LEARN. Only re-merge when there's per-anchor LLM grounding to
  // fold in; the det floor path reuses the cached `floor` as-is (no copy).
  const index = learned.groundingIndex ? mergeGrounding(floor, learned.groundingIndex) : floor;
  _stage(`FLOOR+GROUND: ${index.size} grounded key(s)`, _t); _t = performance.now();

  // CACHE (load) → APPLY — materialise the anchor's cross-boundary bridges from the grounded index + adapters,
  // PLUS the deterministic effect-inference matchers (custom http-client receivers deduced transitively from a
  // grounded fetch/axios sink — so `MyFramework.http.get('/route')` grounds like a built-in fetch caller).
  const httpClients = await _effectClients(repo, ctx);
  const matchers = [..._loadAdapters(repo, ctx), ...httpClientMatchers(httpClients)];
  _stage(`CACHE: ${matchers.length} cached adapter(s) loaded`, _t); _t = performance.now();
  const stats: DcStats = { nodes: 0, parses: 0, parseMs: 0, ranks: 0, rankMs: 0 };
  const p: PipelineCtx = { graph, repo, index, paramIndex, ctx, stats, matchers, httpClients };
  await runPipeline(p, { id: anchorId, file: anchorFile, text: anchorText, lo, hi },
    CHAIN_DEPTH, new Set(), learned.carrierAccesses ?? [], learned.proposedKeys ?? []);
  _stage(`APPLY: ${graph.result().nodes.length} bridge node(s), ${stats.parses} complement parse(s)`, _t);
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
  // key by (kind,value,produces,LABEL): two operations on the SAME route with distinct op names (`createBooking`
  // POST + `getBookings` GET → the bare base) are DISTINCT boundaries — collapsing on (kind,value) alone dropped
  // the second op from the map. An unlabelled key (a raw table/route) has "" and behaves exactly as before.
  const accessId = (k: KeyHit) => `${k.kind} ${k.value} ${k.produces} ${k.label ?? ""}`;
  // 1+2: the located FLOOR (scan + carrier) — span-filtered, earliest line wins, tagged by source
  const addFloor = (hit: KeyHit, source: KeySource) => {
    if (hit.line < spanLo || hit.line > spanHi) return;
    const id = accessId(hit);
    if (!anchorKeys.has(id) || hit.line < anchorKeys.get(id)!.line)
      anchorKeys.set(id, { kind: hit.kind, value: hit.value, produces: hit.produces, line: hit.line, source, ...(hit.label ? { label: hit.label } : {}) });
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
  httpClients: Set<string>; // effect_inference: inferred custom http-client receivers — for the indirected-call route resolver (runPipeline)
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
  // key the boundary NODE by (kind,value,LABEL) so two ops on ONE route (`createBooking`/`getBookings` on the
  // bare base) get DISTINCT nodes and BOTH surface — each still grounds to the same @Path via the value-based
  // complement lookup in crossBoundary. An unlabelled key (raw route/table) → no suffix → one node per route.
  const id = keyId(key.kind, key.value) + (key.label ? `\0${key.label}` : "");
  let boundaryId = boundaryByKey.get(id);
  if (boundaryId === undefined) {
    // LABEL the boundary with the operation name (an endpoint-map `updateBooking`) when the adapter provides one —
    // far more legible than the raw route value; falls back to the value for keys with no human name.
    boundaryId = s.graph.addNode({ symbol: key.label ?? key.value, kind: kindOf(key.kind).nodeKind, file, range: [key.line, key.line], enclosing: "", complexity: 1, coupling: true });
    boundaryByKey.set(id, boundaryId);
  } else if (key.label) {
    // ORDER-INDEPENDENT: a labelled key arriving after the boundary was minted route-first upgrades the label.
    const node = s.graph.nodes.find((n) => n.id === boundaryId);
    if (node && node.symbol === key.value) node.symbol = key.label;
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
  // HUB DAMPING: a key shared by a flood of files is infra (a shared EntityManager/session), not a domain
  // channel — materialize only hubReaderCap of it (the tail stays a fanout blindspot below). Bounds the
  // sprawl AT EACH re-anchor, so the grow stops chasing the hub fan instead of compounding it step over step.
  const cap = complementFiles.size > COUPLING.hubFan ? COUPLING.hubReaderCap : READER_CAP;
  for (const [file, line] of rankedComplements.slice(0, cap)) {
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
  if (rankedComplements.length > cap) {
    const isHub = complementFiles.size > COUPLING.hubFan;
    graph.addBlindspot({ node: boundaryId, mechanism: "shared-key-fanout",
      evidence: `'${key.value}' (${key.kind}) is ${complementProduces ? "written" : "read"} in ${rankedComplements.length} files (showing ${cap}${isHub ? " — infra hub, damped" : ""}) — a data-flow boundary, not a call`,
      candidates: rankedComplements.slice(cap).map(([file]) => ({ file, symbol: key.value, provenance: "SUGGESTED" })) });
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
  // STEP 1d — INDIRECTED http calls on a proven edge: a call to an inferred custom http client with a descriptor
  // ref instead of a literal (`MyFramework.http[method](endpoints.createBooking)`) — resolved against the in-file
  // endpoint-map config (deterministic), surfaced at the call line so THIS method node owns the route crossing.
  for (const hit of resolveHttpCallSites(node.file, node.text, p.httpClients)) {
    if (hit.line < node.lo || hit.line > node.hi) continue;
    const id = `${hit.kind} ${hit.value} ${hit.produces}`;
    if (!keys.has(id) || hit.line < keys.get(id)!.line) keys.set(id, { kind: hit.kind, value: hit.value, produces: hit.produces, line: hit.line, source: "scan" });
  }
  // DIAGNOSTIC (--verbose, or the narrow SEAM_COUPLING_DEBUG): why did a node surface (or fail to surface)
  // couplings? Prints every key this span touches, its source, and how many files sit on the OTHER side
  // (0 = ungrounded → dropped).
  if (verbose() || process.env.SEAM_COUPLING_DEBUG) {
    const anchorPath0 = normpath(node.file);
    const rows = [...keys.values()].map((k) => `${k.kind} '${k.value}' (${k.produces ? "produces" : "consumes"}, ${k.source}) → ${collectComplementFiles(p.index, k, anchorPath0).size} other-side file(s)`);
    process.stderr.write(`[${p.ctx.stableFloor ? "coupling-debug·probe" : "coupling-debug"}] ${node.file}:${node.lo} surfaced ${keys.size} key(s):\n${rows.map((r) => "    " + r).join("\n") || "    (none)"}\n`);
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
