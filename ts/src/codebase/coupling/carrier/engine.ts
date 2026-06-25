// CARRIER-CHANNEL ENGINE — the framework- and language-AGNOSTIC orchestrator of the carrier axis.
// Surfaces homemade-framework data-file coupling: a call to a repo method a provider classifies as a
// read/write carrier, passed a LITERAL path, produces/consumes the `data-file <path>` key. So a
// `save_data(x, 'Save.rxdata')` writer couples to a `load_data('Save.rxdata')` reader across the repo
// with no shared import/call — the exact channel a framework adapter can't see (the wrapper is the
// project's own). Language specifics (key extraction + dispatch + sink tracing) live behind CarrierProvider.
//
// The engine owns the parts that DON'T read source: the repo walk, the teacher-3 opaque-carrier flow
// (cache-only resolve, then ONE batched LLM synthesis for the cache misses, then resolve again from the
// warmed cache), the teacher-2 glob grounding, and the cached repo-wide index. A provider only yields
// per-call OBSERVATIONS; the engine turns the opaque ones into directions and indexes the rest.
import { walkFiles } from "../../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../../core/resolve/languages/base.js";
import { resolveCarrierSignature, prefetchCarrierSignatures } from "./synth.js";
import { globMatch, type CarrierProvider, type CarrierObservation } from "./provider.js";
import { normPath } from "../adapters/http_route.js";
import { RUBY_CARRIER } from "../../../languages/ruby/carrier.js";
import { JAVA_CARRIER } from "../../../languages/java/carrier.js";
import { TS_CARRIER } from "../../../languages/typescript/carrier.js";
import type { Access, GroundingIndex, KeyHit } from "../types.js";
import { EngineCtx, getOrSet } from "../../engine_ctx.js";

// teacher-3 (LLM carrier synthesis) options — opt-in, threaded from --data-coupling llm.
export interface CarrierOpts { llm?: boolean; model?: string; claudeBin?: string | null }

// The carrier-provider registry — one entry per language with a carrier front-end. A new language plugs
// in here (a dispatch + a CallGraph + teacher-2 key extraction) without the engine changing.
export const CARRIER_PROVIDERS: CarrierProvider<any>[] = [RUBY_CARRIER, JAVA_CARRIER, TS_CARRIER];
export function carrierProviderFor(file: string): CarrierProvider<any> | null {
  return CARRIER_PROVIDERS.find((p) => p.handles(file)) ?? null;
}

// Lazy per-(repo, provider) index — built only when the first file of that provider is seen, then reused.
async function _indexFor(repo: string, provider: CarrierProvider<any>, ctx: EngineCtx): Promise<any> {
  return getOrSet(ctx.langIndex, `${repo}::${provider.name}`, () => provider.buildIndex(repo));
}

type CarrierHit = { value: string; produces: boolean; partial: boolean; access: Access; medium?: string };
interface PendingObs { provider: CarrierProvider<any>; index: any; className: string; method: string; value: string; partial: boolean; access: Access }

// Async flatMap: walk carrier files, scan each for observations, yield one observation at a time.
async function* scanCarrierObservations(repo: string, ctx: EngineCtx):
    AsyncGenerator<{ o: CarrierObservation; rel: string; provider: CarrierProvider<any>; index: any; access: Access }> {
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, (r) => carrierProviderFor(r) !== null)) {
    const provider = carrierProviderFor(rel)!;
    const index = await _indexFor(repo, provider, ctx);
    for (const o of await provider.scanFile(repo, index, rel, text))
      yield { o, rel, provider, index, access: { file: rel, line: o.line } };
  }
}

// Pass 1 — resolve each observation: TRACED ones become hits immediately; OPAQUE ones try the offline
// cache first (no LLM), and are enqueued as pending when the cache misses and --data-coupling llm is on.
async function resolveObservations(repo: string, opts: CarrierOpts, ctx: EngineCtx):
    Promise<{ hits: CarrierHit[]; pending: PendingObs[] }> {
  const hits: CarrierHit[] = [];
  const pending: PendingObs[] = [];
  for await (const { o, provider, index, access } of scanCarrierObservations(repo, ctx)) {
    if (o.direction) { hits.push({ value: o.value, produces: o.direction === "write", partial: o.partial, access }); continue; }
    const sig = await resolveCarrierSignature(repo, provider, index, o.callee.className, o.callee.method, ctx);   // cache-only
    if (sig) hits.push({ value: o.value, produces: sig.direction === "write", partial: o.partial, access, medium: sig.medium });
    else if (opts.llm) pending.push({ provider, index, className: o.callee.className, method: o.callee.method, value: o.value, partial: o.partial, access });
  }
  return { hits, pending };
}

// Pass 1b — batch-synthesize all deferred opaque carriers (per provider), then resolve each from the
// warmed cache and return the additional hits.
async function resolvePending(repo: string, pending: PendingObs[], opts: CarrierOpts, ctx: EngineCtx):
    Promise<CarrierHit[]> {
  const byProvider = new Map<CarrierProvider<any>, PendingObs[]>();
  for (const p of pending) { if (!byProvider.has(p.provider)) byProvider.set(p.provider, []); byProvider.get(p.provider)!.push(p); }
  
  // Resolve each pending carrier signature via LLM (one batched call per provider), 
  // persisting each so the later cache-only resolveCarrierSignature finds it. 
  // This is the only LLM path, and it's always a batch of many carriers to amortize the cost — no per-carrier calls.
  for (const [provider, group] of byProvider)
    await prefetchCarrierSignatures(repo, provider, group[0].index, group.map((p) => ({ className: p.className, method: p.method })), opts, ctx);
  
  const hits: CarrierHit[] = [];
  for (const p of pending) {
    const sig = await resolveCarrierSignature(repo, p.provider, p.index, p.className, p.method, ctx);   // cache-only (prefetched)
    if (sig) hits.push({ value: p.value, produces: sig.direction === "write", partial: p.partial, access: p.access, medium: sig.medium });
  }
  return hits;
}

// A hit's grounding KIND + normalised value, from its learned medium. `http-route` grounds under the SAME
// `http-route <path>` key the deterministic adapters use (so a learned custom HTTP client meets a backend
// `@Path`/file-routed handler), with the URL normalised (`{id}`→`*`, query/hash dropped) to that key shape.
// Everything else is a `data-file` channel (the original behaviour — default when no medium is recorded).
function hitKind(h: CarrierHit): { kind: string; value: string } {
  return h.medium === "http-route" ? { kind: "http-route", value: normPath(h.value) } : { kind: "data-file", value: h.value };
}

// Pass 2 — index each hit under its own key, then TEACHER-2 expand: a partial family pattern also grounds
// on every concrete literal it matches, and a literal grounds on every pattern that matches it, so a
// pattern reader couples to a literal writer (and vice versa) at the shared meeting key. PARTITIONED by
// grounding kind so a URL glob never matches a file-path literal (the two media never cross-ground).
export function expandAndIndexHits(hits: CarrierHit[]): GroundingIndex {
  const idx: GroundingIndex = new Map();
  const byKind = new Map<string, { h: CarrierHit; kind: string; value: string }[]>();
  for (const h of hits) { const kv = hitKind(h); (byKind.get(kv.kind) ?? byKind.set(kv.kind, []).get(kv.kind)!).push({ h, ...kv }); }
  for (const [kind, group] of byKind) {
    const concrete = [...new Set(group.filter((g) => !g.h.partial).map((g) => g.value))];
    const patterns = [...new Set(group.filter((g) => g.h.partial).map((g) => g.value))];
    const add = (value: string, produces: boolean, access: Access) => {
      const k = `${kind} ${value}`;
      if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
      (produces ? idx.get(k)!.producers : idx.get(k)!.consumers).push(access);
    };
    for (const { h, value } of group) {
      add(value, h.produces, h.access);                                            // own key
      if (h.partial) for (const c of concrete) { if (globMatch(value, c)) add(c, h.produces, h.access); }   // pattern → matching literals
      else for (const p of patterns) { if (globMatch(p, value)) add(p, h.produces, h.access); }             // literal → matching patterns
    }
  }
  return idx;
}

export async function carrierChannelIndex(repo: string, opts: CarrierOpts = {}, ctx: EngineCtx = new EngineCtx()): Promise<GroundingIndex> {
  const cacheKey = `${repo}::${opts.llm ? "llm" : "det"}`;
  return getOrSet(ctx.carrierChannel, cacheKey, async () => {
    const { hits, pending } = await resolveObservations(repo, opts, ctx);
    if (pending.length) hits.push(...await resolvePending(repo, pending, opts, ctx));
    return expandAndIndexHits(hits);
  });
}

// The anchor body's carrier-channel keys (for attach's per-anchor accs), within [lo,hi] — emitted as plain
// KeyHits (source "carrier" is stamped by collectAnchorKeys). Opaque carriers resolve cache-only here
// (never an inline LLM call) and are dropped if unknown — same as the index pass.
export async function anchorCarrierAccs(repo: string, file: string, text: string, lo: number, hi: number, ctx: EngineCtx = new EngineCtx()): Promise<KeyHit[]> {
  const provider = carrierProviderFor(file);
  if (!provider) return [];
  const index = await _indexFor(repo, provider, ctx);
  const out: KeyHit[] = [];
  for (const o of await provider.scanFile(repo, index, file, text)) {
    if (o.line < lo || o.line > hi) continue;
    let produces: boolean | null = o.direction ? o.direction === "write" : null;
    if (produces === null) { const sig = await resolveCarrierSignature(repo, provider, index, o.callee.className, o.callee.method, ctx); if (sig) produces = sig.direction === "write"; }
    if (produces !== null) out.push({ kind: "data-file", value: o.value, produces, line: o.line });
  }
  return out;
}

// Single entry point for callers that need both the repo-wide carrier index AND the anchor's own
// accesses — the two always go together for the anchor use case, so the module owns the pairing.
export async function resolveAnchorCarrier(
  repo: string, anchorFile: string, anchorText: string, lo: number, hi: number,
  opts: CarrierOpts = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<{ index: GroundingIndex; accesses: KeyHit[] }> {
  const [index, accesses] = await Promise.all([
    carrierChannelIndex(repo, opts, ctx),
    anchorCarrierAccs(repo, anchorFile, anchorText, lo, hi, ctx),
  ]);
  return { index, accesses };
}
