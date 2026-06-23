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
const h = (s: string) => createHash("md5").update(s).digest("hex").slice(0, 16);

let _embedder: any = null;
async function embedder(): Promise<any> {
  if (_embedder) return _embedder;
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowLocalModels = false;                 // pull the small model from the hub, cache in HOME
  _embedder = await pipeline("feature-extraction", MODEL);
  return _embedder;
}

// Is transformers.js loadable at all? Cached so it costs one import attempt per process. Probe BEFORE the
// expensive def walk so an absent lib (the bundled .vsix externalizes it) bails fast to the non-embed path.
let _tfAvailable: boolean | null = null;
async function transformersAvailable(): Promise<boolean> {
  if (_tfAvailable !== null) return _tfAvailable;
  try { await import("@xenova/transformers"); _tfAvailable = true; } catch { _tfAvailable = false; }
  return _tfAvailable;
}

async function embed_one(text: string): Promise<number[]> {
  const out = await (await embedder())(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
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
    for (const v of values) {
      let vec = _strVec.get(v);
      if (!vec) { vec = await embed_one(v); _strVec.set(v, vec); }
      out.set(v, cosine(_intentVec.vec, vec));
    }
  } catch { /* partial/empty → caller falls back to fanout */ }
  return out;
}

// disk cache: embed-string hash → vector, per repo AND MODEL (different models have different dims /
// spaces). Under the OS cache dir (never written into the target repo). Incremental — only new/changed def
// strings are embedded; the rest are reused.
function cachePath(repo: string): string {
  return join(homedir(), ".cache", "seam", "embed", `${h(repo + "|" + MODEL)}.json`);
}
function loadCache(p: string): Record<string, number[]> {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {}; } catch { return {}; }
}

// EVERY repo def scored by cosine similarity of its embed string to the intent, DESC. Lazily embeds (and
// disk-caches) the def table on first use; subsequent queries reuse the cache. Returns [] on any failure /
// when transformers is absent — so all callers degrade to their non-embed path.
export async function embedScoreDefs(repo: string, intent: string, files?: Set<string>): Promise<{ def: Def; score: number }[]> {
  const _et0 = timingOn() ? performance.now() : 0;   // embed-recall wall-clock (--verbose / SEAM_TIMING)
  try {
    if (!(await transformersAvailable())) return [];   // bail before the repo walk when the lib is absent (.vsix → lexical)
    const defs = await enumerate_defs(repo, 4000, files);   // `files` scopes to a footprint (intent-relevance); omitted = whole-repo recall
    if (!defs.length) return [];
    const strings = defs.map(embedString);
    const cp = cachePath(repo);
    const cache = loadCache(cp);
    let dirty = false;
    const misses: number[] = [];
    for (let i = 0; i < strings.length; i++) if (!cache[h(strings[i])]) misses.push(i);
    for (const i of misses) { cache[h(strings[i])] = await embed_one(strings[i]); dirty = true; }
    if (dirty) { mkdirSync(dirname(cp), { recursive: true }); writeFileSync(cp, JSON.stringify(cache)); }
    const iv = await embed_one(QUERY_PREFIX + intent);
    const scored = defs.map((d, i) => ({ def: d, score: cosine(iv, cache[h(strings[i])]) }));
    scored.sort((a, b) => b.score - a.score);
    if (_et0) process.stderr.write(`[timing] embed score: ${Math.round(performance.now() - _et0)}ms (${defs.length} defs, ${misses.length} newly embedded)\n`);
    return scored;
  } catch { return []; }
}
