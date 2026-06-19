// CARRIER-CHANNEL ENGINE — the framework- and language-AGNOSTIC orchestrator of the carrier axis.
// Surfaces homemade-framework data-file coupling: a call to a repo method a provider classifies as a
// read/write carrier, passed a LITERAL path, produces/consumes the `data-file <path>` key. So a
// `save_data(x, 'Save.rxdata')` writer couples to a `load_data('Save.rxdata')` reader across the repo
// with no shared import/call — the exact channel a framework adapter can't see (the wrapper is the
// project's own). Language specifics (key extraction + dispatch + sink tracing) live behind CarrierProvider.
//
// The engine owns the parts that DON'T read source: the repo walk, the OPAQUE→cache→LLM classifier
// ladder (teacher 3), the teacher-2 glob grounding, and the cached repo-wide index. A provider only
// yields per-call OBSERVATIONS; the engine turns the opaque ones into directions and indexes the rest.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "../../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../../core/resolve/languages/base.js";
import { resolveCarrierSignature, prefetchCarrierSignatures } from "./synth.js";
import { globMatch, type CarrierProvider, type CarrierObservation } from "./provider.js";
import { RUBY_CARRIER } from "../../../languages/ruby/carrier.js";
import type { Access } from "../types.js";
import { EngineCtx } from "../../engine_ctx.js";

// teacher-3 (LLM carrier synthesis) options — opt-in, threaded from --data-coupling llm.
export interface CarrierOpts { llm?: boolean; model?: string; claudeBin?: string | null }
type KeyIndex = Map<string, { producers: Access[]; consumers: Access[] }>;

// The carrier-provider registry — one entry per language with a carrier front-end (Ruby is the first).
// A new language plugs in here without the engine changing.
export const CARRIER_PROVIDERS: CarrierProvider<any>[] = [RUBY_CARRIER];
export function carrierProviderFor(file: string): CarrierProvider<any> | null {
  return CARRIER_PROVIDERS.find((p) => p.handles(file)) ?? null;
}

// Lazy per-(repo, provider) index — built only when the first file of that provider is seen, then reused.
async function _indexFor(repo: string, provider: CarrierProvider<any>, ctx: EngineCtx): Promise<any> {
  const k = `${repo}::${provider.name}`;
  if (!ctx.langIndex.has(k)) ctx.langIndex.set(k, await provider.buildIndex(repo));
  return ctx.langIndex.get(k);
}

interface PendingObs { provider: CarrierProvider<any>; index: any; className: string; method: string; value: string; partial: boolean; access: Access }

export async function carrierChannelIndex(repo: string, opts: CarrierOpts = {}, ctx: EngineCtx = new EngineCtx()): Promise<KeyIndex> {
  const cacheKey = `${repo}::${opts.llm ? "llm" : "det"}`;
  if (ctx.carrierChannel.has(cacheKey)) return ctx.carrierChannel.get(cacheKey)!;
  const idx: KeyIndex = new Map();

  // pass 1 — walk the repo; per file, ask its provider for carrier observations. TRACED ones are hits;
  // OPAQUE ones (direction === null) go through the cache→LLM ladder (cache-only here, deferred to pass 1b
  // when --data-coupling llm). A non-carrier call yields no observation at all.
  const hits: { value: string; produces: boolean; partial: boolean; access: Access }[] = [];
  const pending: PendingObs[] = [];
  for (const [dir, files] of walk(repo, SKIP_DIRS)) {
    for (const fn of files) {
      const rel = relative(repo, join(dir, fn)).replace(/\\/g, "/");
      const provider = carrierProviderFor(rel);
      if (!provider) continue;
      let text: string; try { text = readFileSync(join(dir, fn), "utf-8"); } catch { continue; }
      const index = await _indexFor(repo, provider, ctx);
      for (const o of await provider.scanFile(repo, index, rel, text)) {
        const access: Access = { file: rel, line: o.line };
        if (o.direction) { hits.push({ value: o.value, produces: o.direction === "write", partial: o.partial, access }); continue; }
        // opaque → a cached signature (prior run / CI warm-up) resolves it offline; else defer to pass 1b.
        const sig = await resolveCarrierSignature(repo, provider, index, o.callee.className, o.callee.method, {}, ctx);   // cache-only (no llm flag)
        if (sig) hits.push({ value: o.value, produces: sig.direction === "write", partial: o.partial, access });
        else if (opts.llm) pending.push({ provider, index, className: o.callee.className, method: o.callee.method, value: o.value, partial: o.partial, access });
      }
    }
  }

  // pass 1b — BATCH-synthesize all deferred opaque carriers (per provider), then resolve each from cache.
  if (pending.length) {
    const byProvider = new Map<CarrierProvider<any>, PendingObs[]>();
    for (const p of pending) { if (!byProvider.has(p.provider)) byProvider.set(p.provider, []); byProvider.get(p.provider)!.push(p); }
    for (const [provider, group] of byProvider)
      await prefetchCarrierSignatures(repo, provider, group[0].index, group.map((p) => ({ className: p.className, method: p.method })), opts, ctx);
    for (const p of pending) {
      const sig = await resolveCarrierSignature(repo, p.provider, p.index, p.className, p.method, {}, ctx);   // cache-only (prefetched)
      if (sig) hits.push({ value: p.value, produces: sig.direction === "write", partial: p.partial, access: p.access });
    }
  }

  // pass 2 — index each hit under its own key, then TEACHER-2 expand: a partial family pattern also
  // grounds on every concrete literal it matches, and a literal grounds on every pattern that matches it,
  // so a pattern reader couples to a literal writer (and vice versa) at the shared meeting key.
  const concrete = [...new Set(hits.filter((h) => !h.partial).map((h) => h.value))];
  const patterns = [...new Set(hits.filter((h) => h.partial).map((h) => h.value))];
  const add = (value: string, produces: boolean, access: Access) => {
    const k = `data-file ${value}`;
    if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
    (produces ? idx.get(k)!.producers : idx.get(k)!.consumers).push(access);
  };
  for (const h of hits) {
    add(h.value, h.produces, h.access);                                              // own key
    if (h.partial) for (const c of concrete) { if (globMatch(h.value, c)) add(c, h.produces, h.access); }      // pattern → matching literals
    else for (const p of patterns) { if (globMatch(p, h.value)) add(p, h.produces, h.access); }                // literal → matching patterns
  }

  ctx.carrierChannel.set(cacheKey, idx);
  return idx;
}

// The anchor body's carrier-channel keys (for attach's per-anchor accs), within [lo,hi]. Opaque carriers
// resolve cache-only here (never an inline LLM call) and are dropped if unknown — same as the index pass.
export async function anchorCarrierAccs(repo: string, file: string, text: string, lo: number, hi: number, opts: CarrierOpts = {}, ctx: EngineCtx = new EngineCtx()):
    Promise<{ kind: string; value: string; produces: boolean; line: number }[]> {
  const provider = carrierProviderFor(file);
  if (!provider) return [];
  const index = await _indexFor(repo, provider, ctx);
  const out: { kind: string; value: string; produces: boolean; line: number }[] = [];
  for (const o of await provider.scanFile(repo, index, file, text)) {
    if (o.line < lo || o.line > hi) continue;
    let produces: boolean | null = o.direction ? o.direction === "write" : null;
    if (produces === null) { const sig = await resolveCarrierSignature(repo, provider, index, o.callee.className, o.callee.method, {}, ctx); if (sig) produces = sig.direction === "write"; }
    if (produces !== null) out.push({ kind: "data-file", value: o.value, produces, line: o.line });
  }
  return out;
}
