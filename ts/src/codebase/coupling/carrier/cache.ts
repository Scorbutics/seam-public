// PERSISTENT LEARNING-PHASE CACHE — the teacher architecture's "LLM at index-time, deterministic at
// query-time" made durable. A teacher-3 carrier signature, once synthesized, is written to
// `<repo>/.seam/carrier-signatures.json` keyed by `Class#method <sha1(source)>`. A later run — even a
// fully OFFLINE one with no LLM — reads it back and applies it deterministically: synthesize ONCE,
// reuse forever. The content-hash key gives free drift invalidation (edit the method → cache miss →
// re-synthesize). A `null` value is cached too (a known NON-carrier — don't re-ask). The eager variant
// (run `--data-coupling llm` in CI, commit `.seam/`) warms this for a whole team.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CarrierSignature } from "./synth.js";
import { ensureSeamGitignore, sharedSeamDir } from "../seam_dir.js";
import { recordAdapterUsed, recordAdapterLearned } from "../ledger.js";

const SCHEMA = 1;
const _file = "carrier-signatures.json";
const _rel = `.seam/${_file}`;
const _mem = new Map<string, Map<string, CarrierSignature | null>>();   // dir → loaded store (in-memory)

function _path(repo: string): string { return join(repo, _rel); }

// Load a store from a JSON path (cached in-memory per path). Corrupt/absent → empty.
function _loadFrom(path: string): Map<string, CarrierSignature | null> {
  if (_mem.has(path)) return _mem.get(path)!;
  const m = new Map<string, CarrierSignature | null>();
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (data && data.schema === SCHEMA && data.signatures && typeof data.signatures === "object")
      for (const [k, v] of Object.entries<any>(data.signatures)) m.set(k, v as CarrierSignature | null);
  } catch { /* absent or corrupt → empty store */ }
  _mem.set(path, m);
  return m;
}
const _load = (repo: string) => _loadFrom(_path(repo));
const _loadShared = () => _loadFrom(join(sharedSeamDir(), _file));

// Has this key been resolved before? Repo-local store FIRST, then the SHARED ~/.seam store (promoted/common).
export function cachedSignature(repo: string, key: string): { hit: boolean; sig: CarrierSignature | null } {
  const local = _load(repo);
  if (local.has(key)) { const s = local.get(key)!; if (s) recordAdapterUsed(s.name, "repo"); return { hit: true, sig: s }; }
  const shared = _loadShared();
  if (shared.has(key)) { const s = shared.get(key)!; if (s) recordAdapterUsed(s.name, "shared"); return { hit: true, sig: s }; }
  return { hit: false, sig: null };
}

// Does this repo have ANY learned (non-null) carrier adapter — repo-local OR shared? The gate that lets the
// carrier engine run for a NON-Ruby anchor on a warm pass: a learned adapter auto-applies deterministically
// (no LLM, no promotion) the next time it's seen — "reuse before promote". Cheap (reads the two cache maps).
export function hasLearnedCarrier(repo: string): boolean {
  for (const v of _load(repo).values()) if (v) return true;
  for (const v of _loadShared().values()) if (v) return true;
  return false;
}

// All LEARNED (non-null) carrier adapters — repo-local + shared — for `seam-adapters list`.
export function listLearnedAdapters(repo: string): { key: string; sig: CarrierSignature; scope: "repo" | "shared" }[] {
  const out: { key: string; sig: CarrierSignature; scope: "repo" | "shared" }[] = [];
  for (const [k, v] of _load(repo)) if (v) out.push({ key: k, sig: v, scope: "repo" });
  for (const [k, v] of _loadShared()) if (v) out.push({ key: k, sig: v, scope: "shared" });
  return out;
}

// PROMOTE a repo-learned adapter (by its friendly name) into the shared ~/.seam store for review/reuse.
export function promoteSignature(repo: string, name: string): { ok: boolean; sig?: CarrierSignature } {
  for (const [k, v] of _load(repo)) {
    if (!v || v.name !== name) continue;
    const sharedPath = join(sharedSeamDir(), _file);
    const shared = _loadShared(); shared.set(k, v);
    try {
      mkdirSync(dirname(sharedPath), { recursive: true });
      const signatures: Record<string, CarrierSignature | null> = {};
      for (const [kk, vv] of shared) signatures[kk] = vv;
      writeFileSync(sharedPath, JSON.stringify({ schema: SCHEMA, signatures }, null, 2));
    } catch { return { ok: false }; }
    return { ok: true, sig: v };
  }
  return { ok: false };
}

// Record a resolved signature (or null = non-carrier) and flush the store to disk. Best-effort: a write
// failure (read-only checkout) is swallowed — the in-memory cache still serves this process.
export function persistSignature(repo: string, key: string, sig: CarrierSignature | null): void {
  if (sig) recordAdapterLearned(sig.name);   // a real (non-null) carrier adapter learned this run
  const m = _load(repo);
  m.set(key, sig);
  try {
    const p = _path(repo);
    mkdirSync(dirname(p), { recursive: true });
    ensureSeamGitignore(repo);
    const signatures: Record<string, CarrierSignature | null> = {};
    for (const [k, v] of m) signatures[k] = v;
    writeFileSync(p, JSON.stringify({ schema: SCHEMA, signatures }, null, 2));
  } catch { /* read-only repo → keep the in-memory cache only */ }
}

// test/CI hook — drop the in-memory store so a fresh disk read happens next.
export function _resetCarrierCacheMem(): void { _mem.clear(); }
export { _rel as CARRIER_CACHE_REL };
