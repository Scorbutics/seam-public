// DEF EMBEDDING — the shared, deterministic intent-relevance primitive (scan layer, so both anchor recall
// and the grow intent-ranker can use it without a layering back-edge). It embeds the repo's def table
// (signature + enclosing + path + doc, via embedString) and scores each def by cosine similarity to an
// intent. transformers.js + the ~23 MB model are lazily imported so the default build/.vsix carries
// neither unless embedding is actually used; every caller degrades to its non-embed path when it's absent.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { enumerate_defs, embedString, type Def } from "./def_table.js";
import { timingOn } from "../../core/progress.js";

const MODEL = process.env.SEAM_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
// Whole-repo recall ENUMERATES up to this many defs (ALPHABETICAL order). Enumeration is just a parse
// (~0.005 ms/def — cheap), and the retrieve-then-rerank pre-filter below bounds the EXPENSIVE embed to
// PREFILTER_M regardless, so this can be generous: it only guards a module sorted late (web-acmecheck
// after web-manage) from being cut off the candidate set entirely. Env-overridable; warns if hit.
const _envInt = (k: string, d: number): number => { const v = parseInt(process.env[k] ?? "", 10); return Number.isFinite(v) && v > 0 ? v : d; };
const DEF_LIMIT = _envInt("SEAM_DEF_LIMIT", 15000);
// RETRIEVE-then-rerank: embedding every whole-repo def is O(N) CPU (~15 ms/def — minutes at a raised
// DEF_LIMIT), while the cosine SEARCH is ~instant. So when the def set is large, a cheap lexical pre-filter
// narrows it to the top-M most intent-overlapping defs and ONLY those are embedded — bounding the cold cost
// to M regardless of repo size, with the embedding still doing the fine semantic re-rank on the shortlist.
const PREFILTER_M = _envInt("SEAM_EMBED_PREFILTER", 800);

// WHY-ANCHOR tracer — set SEAM_WHY_ANCHOR=<path-or-name-substring> to learn why a file/symbol is (not) a
// candidate. It reports the target's fate at EACH recall stage — enumerated? within the def cap? survived the
// lexical pre-filter? what embed rank? — so a "missing candidate" is DIAGNOSED (size crop vs not-extracted vs
// low relevance), not guessed. Decision table printed alongside so the right knob is unambiguous. Diagnostic
// only (stderr); matches a def by file path OR symbol name (substring, case-insensitive).
const WHY = (process.env.SEAM_WHY_ANCHOR || "").toLowerCase();
const _whyMatch = (d: Def) => !!WHY && (d.file.toLowerCase().includes(WHY) || d.name.toLowerCase().includes(WHY));
const _why = (msg: string) => process.stderr.write(`[why-anchor] ${msg}\n`);

// Morphology-tolerant tokens of a string: split camelCase + non-alnum, lowercase, ≥3 chars. "bookingService"
// → {booking, service}. A RECALL net (candidate generation), not a meaning judgement — the embedding judges
// meaning; this only decides which defs are cheap-enough-to-be-worth embedding.
function _tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.split(/[^A-Za-z0-9]+/))
    for (const part of raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/)) {
      const w = part.toLowerCase();
      if (w.length >= 3) out.add(w);
    }
  return out;
}
// Generous overlap: an intent term scores a def if any def token shares its 4-char prefix (bridges
// booking/bookings/booked without a stemmer). Counts distinct matching terms.
function _overlap(defTokens: Set<string>, terms: string[]): number {
  let s = 0;
  for (const t of terms) {
    const p = t.length >= 4 ? t.slice(0, 4) : t;
    for (const dt of defTokens) if (dt === t || (t.length >= 4 && dt.length >= 4 && (dt.startsWith(p) || t.startsWith(dt.slice(0, 4))))) { s++; break; }
  }
  return s;
}
// Keep the top-M defs by lexical overlap with the intent terms (highest-overlap first; ties keep input
// order). Pure + LLM-free → unit-testable. Always returns min(M, defs.length) — high-overlap defs are
// guaranteed in; remaining slots fill deterministically so a purely-semantic def still gets a chance.
export function lexicalPreFilter(defs: Def[], terms: string[], m: number): Def[] {
  if (defs.length <= m || !terms.length) return defs.slice(0, m);
  const scored = defs.map((d, i) => ({ d, i, s: _overlap(_tokens(embedString(d)), terms) }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return scored.slice(0, m).map((x) => x.d);
}
const h = (s: string) => createHash("md5").update(s).digest("hex").slice(0, 16);

let _embedder: any = null;
async function embedder(): Promise<any> {
  if (_embedder) return _embedder;
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowLocalModels = false;                 // pull the small model from the hub, cache in HOME
  // WHICH WEIGHTS. transformers.js defaults to the INT8-quantized file, and int8 kernels differ between
  // execution providers — onnxruntime-web here vs native ORT in the Rust core — by up to ~3e-2 on a cosine.
  // That is the same order as the distance between a real def score and `tierMargin`/`couplingMargin`, so the
  // two engines' fields can flip a borderline complement while both are working correctly (measured:
  // `_patch.ts` = 0.2741 here, 0.2452 there, against a 0.25 margin). On fp32 they agree to 3.7e-7. The DEFAULT
  // is unchanged (int8 — the cached artifact most machines already have); SEAM_EMBED_QUANTIZED=0 selects fp32,
  // the same knob and the same spelling the Rust side reads, so both engines can be put on one set of weights.
  _embedder = await pipeline("feature-extraction", MODEL, { quantized: process.env.SEAM_EMBED_QUANTIZED !== "0" });
  return _embedder;
}

// Is transformers.js loadable at all? Cached so it costs one import attempt per process. Probe BEFORE the
// expensive def walk so an absent lib (the bundled .vsix externalizes it) bails fast to the non-embed path.
let _tfAvailable: boolean | null = null;
export async function transformersAvailable(): Promise<boolean> {
  if (_tfAvailable !== null) return _tfAvailable;
  try { await import("@xenova/transformers"); _tfAvailable = true; } catch { _tfAvailable = false; }
  return _tfAvailable;
}

async function embed_one(text: string): Promise<number[]> {
  const out = await (await embedder())(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

// BATCHED embed — one forward pass for N strings instead of N sequential calls. transformers.js accepts an
// array and returns an [N, dim] tensor (flat .data, .dims). This is the difference between a hub node's key
// ranking costing one inference vs ~60 (the serial loop made an --intent grow on a big component hang).
async function embed_many(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const out = await (await embedder())(texts, { pooling: "mean", normalize: true });
  const data = out.data as Float32Array;
  const dim = (out.dims as number[])[out.dims.length - 1] || data.length;
  const vecs: number[][] = [];
  for (let i = 0; i < texts.length; i++) vecs.push(Array.from(data.subarray(i * dim, (i + 1) * dim)));
  return vecs;
}
const cosine = (a: number[], b: number[]): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// BGE-family retrieval models expect an instruction prefix on the QUERY (not the passages); a generic
// model (MiniLM/mpnet) wants none. Applied to the intent only.
const QUERY_PREFIX = /bge/i.test(MODEL) ? "Represent this sentence for searching relevant passages: " : "";

// Score raw STRINGS (shared-key values) by cosine similarity to the intent — used to rank which keys a hub
// node keeps vs demotes to a blindspot, so the demoted ones are the LEAST intent-relevant (not just the
// most-shared). In-memory cached: key values are short and recur across nodes; the intent vector is memoised.
// Returns {} when transformers is absent / on any error → the caller falls back to its deterministic order.
const _strVec = new Map<string, number[]>();          // key value → vector (per process)
let _intentVec: { intent: string; vec: number[] } | null = null;
export async function embedScoreStrings(intent: string, values: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    if (!intent || !values.length || !(await transformersAvailable())) return out;
    if (_intentVec?.intent !== intent) _intentVec = { intent, vec: await embed_one(QUERY_PREFIX + intent) };
    const missing = [...new Set(values)].filter((v) => !_strVec.has(v));   // dedupe + only the uncached
    if (missing.length) {
      const vecs = await embed_many(missing);                             // ONE batched pass (was N serial)
      missing.forEach((v, i) => { if (vecs[i]) _strVec.set(v, vecs[i]); });
    }
    for (const v of values) { const vec = _strVec.get(v); if (vec) out.set(v, cosine(_intentVec.vec, vec)); }
  } catch { /* partial/empty → caller falls back to fanout */ }
  return out;
}

// disk cache: embed-string hash → vector, per repo AND MODEL (different models have different dims /
// spaces). Under the OS cache dir (never written into the target repo). Incremental — only new/changed def
// strings are embedded; the rest are reused.
function cachePath(repo: string): string {
  // KEYED BY THE WEIGHTS, not just the model. The cache maps md5(embedString) → vector, so without the
  // quantization in the key a run on fp32 silently REUSES int8 vectors for every string a previous run saw and
  // computes fp32 ones only for the new strings — a single field built from two different sets of weights,
  // which is worse than either. Measured: forcing fp32 on both engines moved the intent-grow comparison the
  // WRONG way until this was fixed, because the TS side was serving a mixed cache.
  const weights = process.env.SEAM_EMBED_QUANTIZED === "0" ? "fp32" : "int8";
  return join(homedir(), ".cache", "seam", "embed", `${h(repo + "|" + MODEL + "|" + weights)}.json`);
}
function loadCache(p: string): Record<string, number[]> {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {}; } catch { return {}; }
}

// EVERY repo def scored by cosine similarity of its embed string to the intent, DESC. Lazily embeds (and
// disk-caches) the def table on first use; subsequent queries reuse the cache. Returns [] on any failure /
// when transformers is absent — so all callers degrade to their non-embed path.
export async function embedScoreDefs(repo: string, intent: string, files?: Set<string>): Promise<{ def: Def; score: number; vec: number[] }[]> {
  const _et0 = timingOn() ? performance.now() : 0;   // embed-recall wall-clock (--verbose / SEAM_TIMING)
  try {
    if (!(await transformersAvailable())) return [];   // bail before the repo walk when the lib is absent (.vsix → lexical)
    // moduleDefs (whole-repo recall only): add a file-level candidate per file so a file whose identity
    // isn't a named symbol (a module.exports/Vue-plugin/config) is still recallable by its name+doc+path.
    let defs = await enumerate_defs(repo, DEF_LIMIT, files, { moduleDefs: !files });   // `files` scopes to a footprint; omitted = whole-repo recall
    if (!defs.length) return [];
    const capHit = !files && defs.length >= DEF_LIMIT;
    // LOUD truncation: candidate_source_files is ALPHABETICAL, so hitting the cap whole-repo silently drops
    // every module sorted later (a monorepo's web-z never enumerated → never a candidate). Never silently
    // cap recall — tell the user the knob. (Footprint-scoped `files` runs are already bounded, so skip then.)
    if (capHit)
      process.stderr.write(`[anchor] WARNING: def enumeration hit the ${DEF_LIMIT}-def cap (alphabetical) — modules sorted after the cut are NOT recalled. Raise it with SEAM_DEF_LIMIT=<n>.\n`);
    if (WHY) {
      const hits = defs.filter(_whyMatch);
      _why(`'${process.env.SEAM_WHY_ANCHOR}': STAGE 1 enumerate — ${hits.length} matching def(s) of ${defs.length}${capHit ? ` (cap ${DEF_LIMIT} HIT)` : ""}.`);
      if (hits.length) _why(`  e.g. ${hits.slice(0, 6).map((d) => `${d.name} (${d.file})`).join(", ")}`);
      else _why(capHit
        ? `  → 0 enumerated AND the alphabetical cap was hit ⇒ likely a SIZE crop: re-run with SEAM_DEF_LIMIT=${DEF_LIMIT * 5}. If it appears, that was it.`
        : `  → 0 enumerated and the cap was NOT hit ⇒ NOT a size crop: the file's symbols aren't EXTRACTED as defs (a scan/extraction gap for this file shape), or the substring is wrong.`);
    }
    // RETRIEVE-then-rerank (whole-repo only — footprint-scoped `files` is already bounded): narrow a large
    // def set to the M most intent-overlapping before the expensive embed, so cold cost is bounded by M.
    if (!files && defs.length > PREFILTER_M) {
      const before = defs.length;
      const whyBefore = WHY ? defs.filter(_whyMatch).length : 0;
      defs = lexicalPreFilter(defs, [..._tokens(intent)], PREFILTER_M);
      if (timingOn()) process.stderr.write(`[timing] lexical pre-filter: ${before} → ${defs.length} defs (SEAM_EMBED_PREFILTER)\n`);
      if (WHY && whyBefore) {
        const whyAfter = defs.filter(_whyMatch).length;
        _why(`STAGE 2 lexical pre-filter — kept ${whyAfter}/${whyBefore} matching def(s) (${before}→${defs.length} of cap ${PREFILTER_M}).`);
        if (!whyAfter) _why(`  → dropped here: the target's TOKENS don't overlap the intent "${intent}". SIZE-triggered (>${PREFILTER_M} defs). Re-run with SEAM_EMBED_PREFILTER=${Math.max(before, PREFILTER_M * 10)} to embed it anyway (slower) — if it then ranks, reword the intent or raise this knob.`);
      }
    }
    const strings = defs.map(embedString);
    const cp = cachePath(repo);
    const cache = loadCache(cp);
    let dirty = false;
    const misses: number[] = [];
    for (let i = 0; i < strings.length; i++) if (!cache[h(strings[i])]) misses.push(i);
    for (const i of misses) { cache[h(strings[i])] = await embed_one(strings[i]); dirty = true; }
    if (dirty) { mkdirSync(dirname(cp), { recursive: true }); writeFileSync(cp, JSON.stringify(cache)); }
    const iv = await embed_one(QUERY_PREFIX + intent);
    // `vec` carries the def's cached embedding (already computed above) so a caller can build a REGION
    // centroid field (grow/orchestrate `centroid`/`blend` border) without a second embed pass.
    const scored = defs.map((d, i) => ({ def: d, score: cosine(iv, cache[h(strings[i])]), vec: cache[h(strings[i])] }));
    scored.sort((a, b) => b.score - a.score);
    if (_et0) process.stderr.write(`[timing] embed score: ${Math.round(performance.now() - _et0)}ms (${defs.length} defs, ${misses.length} newly embedded)\n`);
    if (WHY) {
      const rank = scored.findIndex((s) => _whyMatch(s.def));
      if (rank < 0) _why(`STAGE 3 embed rank — target NOT in the embedded set (dropped at an earlier stage; see above).`);
      else {
        const ANCHOR_EMBED_TOP = _envInt("SEAM_ANCHOR_EMBED_TOP", 28);
        _why(`STAGE 3 embed rank — best match at #${rank} of ${scored.length} (score ${scored[rank].score.toFixed(3)}): ${scored[rank].def.name} (${scored[rank].def.file}).`);
        _why(rank < ANCHOR_EMBED_TOP
          ? `  → within SEAM_ANCHOR_EMBED_TOP (${ANCHOR_EMBED_TOP}) ⇒ it IS recalled into the pool. If still not a final candidate, it was hub-demoted or the LLM judge dropped it (not a recall/size issue).`
          : `  → ranked BELOW SEAM_ANCHOR_EMBED_TOP (${ANCHOR_EMBED_TOP}) ⇒ NOT a size crop: a RELEVANCE crop. Raise SEAM_ANCHOR_EMBED_TOP, or the intent wording genuinely matches other files better.`);
      }
    }
    return scored;
  } catch { return []; }
}
