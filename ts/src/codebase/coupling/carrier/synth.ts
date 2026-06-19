// TEACHER 3 — LLM carrier-signature synthesis. For an OPAQUE carrier (a method teacher 1 couldn't trace
// to a sink because it delegates to an external object / a runtime-computed channel), the LLM reads the
// method ONCE and emits a CONSTRAINED signature IR (direction + medium + which arg is the channel key).
// This is the "LLM at index-time, deterministic at query-time" teacher: the output is a small declarative
// record, content-hash cached (drift invalidation), validated/grounded, and never a free-text guess.
//
// Gated (opt-in `--data-coupling llm`) + budgeted; the LLM seam is the shared run_pass (host-bus in
// tests / claude|copilot in prod), so no API key. A signature with no valid direction = "not a carrier".
import { createHash } from "node:crypto";
import { run_pass, ClassifierError as LLMError } from "../../../core/llm.js";
import { emit } from "../../../core/progress.js";
import type { CarrierProvider } from "./provider.js";
import { cachedSignature, persistSignature } from "./cache.js";
import { EngineCtx } from "../../engine_ctx.js";

// A learned carrier adapter. `name`/`description` are LLM-given so `.seam/` is human-reviewable (and
// promotable) — not opaque content-hashes. `name` is short + kebab-case; `description` is one line.
export interface CarrierSignature { direction: "read" | "write"; medium: string; keyArg: number | null; name: string; description: string }

const _slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

const _DIRS = new Set(["read", "write"]);
const _MEDIA = new Set(["file", "db", "serialized", "blob", "cache", "data"]);
// in-mem signature cache (ctx.carrierSig) + the run budget (ctx.synthBudget) now live on the EngineCtx —
// a fresh ctx is a clean slate, so the old resetCarrierSynthBudget() hook is gone.

function _prompt(lang: string, className: string, method: string, source: string): string {
  return `You are deciding whether ONE ${lang} method is a DATA I/O CARRIER — a method that READS or WRITES
persistent data (a file, a database, a serialized/blob store) for a channel named by one of its ARGUMENTS
(e.g. a filename or table name). It is NOT a carrier if it is pure computation, networking, logging, or
CODE-loading (require/eval). Static tracing could not classify it (it delegates to an opaque object or a
runtime-computed target), so judge from the code.

METHOD ${className}#${method}:
${source.slice(0, 3000)}

If it IS a data carrier, emit ONE signature. If NOT, emit an empty array. Do NOT guess — a wrong
signature is worse than silence.

If it IS a carrier, also give a short kebab-case "name" (e.g. "vd-file-writer") and a one-line
"description" of what it reads/writes — these help a human review the learned adapter.

Return a JSON array with AT MOST ONE object:
[{"id":"s1","direction":"read|write","medium":"file|db|serialized|blob|cache","keyArg":<0-based index of the argument naming the channel, or null>,"name":"short-kebab-name","description":"one line"}]
`;
}

// Validate one LLM object → a grounded signature, or null (not a carrier / invalid).
function _validate(obj: any): CarrierSignature | null {
  if (!obj || typeof obj !== "object") return null;
  const direction = String(obj.direction ?? "").trim().toLowerCase();
  if (!_DIRS.has(direction)) return null;                      // "none"/invalid → not a carrier
  let medium = String(obj.medium ?? "data").trim().toLowerCase();
  if (!_MEDIA.has(medium)) medium = "data";                    // ground the medium to the known set
  const keyArg = Number.isInteger(obj.keyArg) && obj.keyArg >= 0 ? obj.keyArg : null;
  const name = _slug(String(obj.name ?? "").trim());
  const description = String(obj.description ?? "").trim().slice(0, 200);
  return { direction: direction as "read" | "write", medium, keyArg, name, description };
}
// Fill a fallback name/description when the LLM omitted them, so every stored adapter is identifiable.
function _named(sig: CarrierSignature | null, className: string, method: string): CarrierSignature | null {
  if (!sig) return null;
  if (!sig.name) sig.name = _slug(`${className}-${method}`);
  if (!sig.description) sig.description = `${sig.direction}s ${sig.medium} via ${className}#${method}`;
  return sig;
}
function _parse(out: Map<string, any>): CarrierSignature | null {
  for (const obj of out.values()) { const s = _validate(obj); if (s) return s; }
  return null;
}

function _ck(className: string, method: string, src: string): string {
  return `${className}#${method} ${createHash("sha1").update(src).digest("hex")}`;
}

function _batchPrompt(lang: string, items: { className: string; method: string; src: string }[]): string {
  const blocks = items.map((it, i) => `=== m${i}: ${it.className}#${it.method} ===\n${it.src.slice(0, 1500)}`).join("\n\n");
  return `You are classifying MULTIPLE ${lang} methods. Each is POSSIBLY a DATA I/O CARRIER — a method that
READS or WRITES persistent data (file/db/serialized/blob/cache) for a channel named by one of its
ARGUMENTS. It is NOT a carrier if it is pure computation, networking, logging, or CODE-loading. Judge each
from its code; emit a signature ONLY for the methods that ARE carriers (omit the rest). A wrong signature
is worse than silence.

${blocks}

For each carrier give a short kebab-case "name" and a one-line "description" (for human review).

Return a JSON array (one object per CARRIER method, by its m-id):
[{"id":"m0","direction":"read|write","medium":"file|db|serialized|blob|cache","keyArg":<0-based arg index naming the channel, or null>,"name":"short-kebab-name","description":"one line"}]
`;
}

// BATCH prefetch — synthesize signatures for many opaque carriers in ONE LLM call per chunk, persisting
// each (so the later cache-only resolveCarrierSignature finds them). Dedups + skips already-cached. This
// is what collapses the per-method carrier-synth fan-out. No-op without opts.llm.
export async function prefetchCarrierSignatures<Idx>(
  repo: string, provider: CarrierProvider<Idx>, index: Idx, reqs: { className: string; method: string }[],
  opts: { llm?: boolean; model?: string; claudeBin?: string | null } = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<void> {
  if (!opts.llm) return;
  const seen = new Set<string>();
  const todo: { className: string; method: string; src: string; ck: string }[] = [];
  for (const r of reqs) {
    const id = `${r.className}#${r.method}`;
    if (seen.has(id)) continue; seen.add(id);
    const src = await provider.methodSource(repo, index, r.className, r.method);
    if (!src) continue;
    const ck = _ck(r.className, r.method, src);
    if (ctx.carrierSig.has(ck) || cachedSignature(repo, ck).hit) continue;   // already known (run ctx or disk)
    todo.push({ className: r.className, method: r.method, src, ck });
  }
  if (!todo.length) return;
  emit(`Learning ${todo.length} carrier adapter(s) via LLM (one batched call)…`);
  let chunk: typeof todo = [], size = 0;
  const flush = () => {
    if (!chunk.length || ctx.synthBudget <= 0) { chunk = []; size = 0; return; }
    ctx.synthBudget -= chunk.length;
    let out = new Map<string, any>();
    try { out = run_pass(_batchPrompt(provider.name, chunk), { model: opts.model, claudeBin: opts.claudeBin, tag: "carrier-synthesis-batch" }); }
    catch (e) { if (!(e instanceof LLMError)) throw e; }
    chunk.forEach((t, i) => { const sig = _named(_validate(out.get(`m${i}`)), t.className, t.method); ctx.carrierSig.set(t.ck, sig); persistSignature(repo, t.ck, sig); });
    chunk = []; size = 0;
  };
  for (const t of todo) { const len = Math.min(t.src.length, 1500); if (size + len > 6000 && chunk.length) flush(); chunk.push(t); size += len; }
  flush();
}

// Resolve a carrier signature for an OPAQUE method — the teacher-3 funnel:
//   1. in-memory cache (this process)
//   2. PERSISTENT .seam/ cache (a prior run / CI warm-up) — applied even OFFLINE: synthesize once, reuse forever
//   3. the LLM, ONLY when `opts.llm` (the --data-coupling llm opt-in) and within budget — then persist
// Returns null = not a carrier / no cache + no LLM / budget exhausted. The content-hash key gives drift
// invalidation (edit the method → miss → re-resolve).
export async function resolveCarrierSignature<Idx>(
  repo: string, provider: CarrierProvider<Idx>, index: Idx, className: string, method: string,
  opts: { llm?: boolean; model?: string; claudeBin?: string | null } = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<CarrierSignature | null> {
  const src = await provider.methodSource(repo, index, className, method);
  if (!src) return null;
  const ck = `${className}#${method} ${createHash("sha1").update(src).digest("hex")}`;
  if (ctx.carrierSig.has(ck)) return ctx.carrierSig.get(ck)!;  // 1. process memory (this run's ctx)
  const disk = cachedSignature(repo, ck);                     // 2. persistent .seam/ (offline-safe)
  if (disk.hit) { ctx.carrierSig.set(ck, disk.sig); return disk.sig; }
  if (!opts.llm || ctx.synthBudget <= 0) return null;          // 3. LLM only when opted-in + budgeted
  ctx.synthBudget -= 1;
  let sig: CarrierSignature | null = null;
  try { sig = _named(_parse(run_pass(_prompt(provider.name, className, method, src), { model: opts.model, claudeBin: opts.claudeBin, tag: "carrier-synthesis" })), className, method); }
  catch (e) { if (!(e instanceof LLMError)) throw e; sig = null; }
  ctx.carrierSig.set(ck, sig);
  persistSignature(repo, ck, sig);                            // learn once → durable for offline runs
  return sig;
}
