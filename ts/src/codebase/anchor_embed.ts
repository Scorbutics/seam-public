// EMBEDDING ANCHOR RECALL (opt-in, #2 Slice B). A semantic recall layer over the DEF TABLE — it surfaces
// the anchor whose NAME doesn't lexically match the intent (the name-filter's blind spot), which the
// parity-locked lexical floor can't. ADDITIVE: its output unions with the lexical candidates and flows
// into the existing probe→judge; it never touches the floor. Deterministic def enumeration + a SUGGEST
// similarity ranking; the LLM judge still SELECTS. transformers.js is lazily imported so the default
// build/.vsix carries neither the lib nor the ~23 MB model unless embed-recall is actually used.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { enumerate_defs, embedString, type Def } from "./def_table.js";

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

// Is transformers.js loadable at all? Cached so it costs one import attempt per process. Embed recall is
// the DEFAULT now, but the bundled .vsix externalizes the lib — so probe BEFORE the expensive def walk and
// bail fast (→ falls back to lexical) instead of scanning the whole repo only to fail the import.
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

// disk cache: embed-string hash → vector, per repo AND MODEL (different models have different dims /
// spaces — keying by repo alone would mix incompatible vectors), under the OS cache dir (never written
// into the target repo). Incremental — only new/changed def strings are embedded; the rest are reused.
function cachePath(repo: string): string {
  return join(homedir(), ".cache", "seam", "embed", `${h(repo + "|" + MODEL)}.json`);
}
function loadCache(p: string): Record<string, number[]> {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {}; } catch { return {}; }
}

// Top-K defs by cosine similarity of their embed string to the intent. Lazily embeds (and caches) the
// def table on first use; subsequent queries reuse the cache. Returns [] on any failure (so the caller
// falls back to the lexical floor — embed recall is strictly additive, never load-bearing).
export async function embed_anchor_candidates(repo: string, intent: string,
    opts: { k?: number } = {}): Promise<Def[]> {
  const _et0 = process.env.SEAM_TIMING ? performance.now() : 0;   // embed-recall wall-clock (opt-in)
  try {
    if (!(await transformersAvailable())) return [];   // bail before the repo walk when the lib is absent (.vsix → lexical)
    const defs = enumerate_defs(repo);
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
    const scored = defs.map((d, i) => ({ d, s: cosine(iv, cache[h(strings[i])]) }));
    scored.sort((a, b) => b.s - a.s);
    if (_et0) process.stderr.write(`[timing] embed recall: ${Math.round(performance.now() - _et0)}ms (${defs.length} defs, ${misses.length} newly embedded)\n`);
    return scored.slice(0, opts.k ?? 20).map((x) => x.d);
  } catch { return []; }
}
