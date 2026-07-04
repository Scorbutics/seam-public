// PERSISTENT LEARNED KEY-ADAPTER STORE — the single `.seam/` home for the shared-key axis's two learnings,
// which are tiers of ONE thing (a learned shared-key adapter) at different GENERALITY:
//   • rules — REUSABLE KeyMatcher rules (key_ir.ts: call/assign/method/attr). General: one rule
//             (`$emit('x')` → event x) re-executed over EVERY file, this run and forever.
//   • files — per-FILE literal keys (a KeyAdapter), the residual the flywheel couldn't generalise into a
//             rule. Specific: keyed `<file> <sha1(text)>`, so a file edit drift-invalidates just its entry.
// LLM once → deterministic forever (a warm `.seam/` applies them with no LLM; CI warm-up commits it). Repo-
// local store read FIRST, then the shared ~/.config/seam store (promoted/common). Carrier signatures are a
// DIFFERENT axis (how data flows THROUGH a file) → their own store (carrier/cache.ts), deliberately not here.
//
// Backward-compat: this MERGES the two former split files. On load it also reads the legacy `key-matchers.json`
// ({matchers}) and the legacy schema-2 `key-adapters.json` ({adapters}) and folds them in; on write it emits
// the unified schema-3 `key-adapters.json` ({rules, files}) and removes the now-redundant legacy matchers file.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { KeyAdapter, KeyHit } from "./types.js";
import { type KeyMatcher, matcherKey } from "./key_ir.js";
import { SEAM_DIR, ensureSeamGitignore, sharedSeamDir } from "./seam_dir.js";
import { recordAdapterUsed, recordAdapterLearned } from "./ledger.js";

const SCHEMA = 3;                          // unified {rules, files}; legacy: matchers (schema 1) / adapters (schema 2)
const _file = "key-adapters.json";
const _legacyMatchers = "key-matchers.json";
const _rel = `${SEAM_DIR}/${_file}`;

type Store = { rules: KeyMatcher[]; files: Map<string, KeyAdapter>; learnedSigs: Set<string> };
const _mem = new Map<string, Store>();     // DIR → loaded store

const _repoDir = (repo: string): string => join(repo, SEAM_DIR);
const _sharedDir = (): string => sharedSeamDir();
const _id = (m: KeyMatcher): string => matcherKey(m);
const _label = (m: KeyMatcher): string => m.name ?? matcherKey(m);

function _readJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

// Load (and memoise) the unified store for a DIR, folding in the legacy split files for backward-compat.
function _loadStore(dir: string): Store {
  if (_mem.has(dir)) return _mem.get(dir)!;
  const store: Store = { rules: [], files: new Map(), learnedSigs: new Set() };
  const main = _readJson(join(dir, _file));
  if (main && main.schema === SCHEMA) {
    if (Array.isArray(main.rules)) store.rules.push(...(main.rules as KeyMatcher[]));
    if (Array.isArray(main.learnedSigs)) for (const s of main.learnedSigs) store.learnedSigs.add(s);
    if (main.files && typeof main.files === "object")
      for (const [k, v] of Object.entries<any>(main.files)) if (v && Array.isArray(v.keys)) store.files.set(k, v as KeyAdapter);
  } else if (main && main.schema === 2 && main.adapters && typeof main.adapters === "object") {
    for (const [k, v] of Object.entries<any>(main.adapters)) if (v && Array.isArray(v.keys)) store.files.set(k, v as KeyAdapter);   // legacy per-file-only
  }
  const legacy = _readJson(join(dir, _legacyMatchers));   // legacy reusable-rules file → fold into rules
  if (legacy && legacy.schema === 1 && Array.isArray(legacy.matchers)) {
    const have = new Set(store.rules.map(_id));
    for (const m of legacy.matchers as KeyMatcher[]) if (!have.has(_id(m))) { have.add(_id(m)); store.rules.push(m); }
  }
  _mem.set(dir, store);
  return store;
}

// Persist a DIR's store as the unified schema-3 file, then drop the now-redundant legacy matchers file.
function _writeStore(dir: string): void {
  const store = _loadStore(dir);
  const files: Record<string, KeyAdapter> = {};
  for (const [k, v] of store.files) files[k] = v;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, _file), JSON.stringify({ schema: SCHEMA, rules: store.rules, files, learnedSigs: [...store.learnedSigs] }, null, 2));
  try { if (existsSync(join(dir, _legacyMatchers))) unlinkSync(join(dir, _legacyMatchers)); } catch { /* best-effort */ }
}

// ── RULES (reusable matchers) ────────────────────────────────────────────────────────────────────────
// True if EITHER store holds a learned matcher rule (so an offline det run applies them — the warm path).
export function hasMatcherCache(repo: string): boolean {
  return _loadStore(_repoDir(repo)).rules.length > 0 || _loadStore(_sharedDir()).rules.length > 0;
}

// Matcher LEARNING is keyed by a signature of its blind-file input: once we've LLM-learned rules for a given
// set of floor-blind files, re-running over the SAME set (a re-run with the same intent) must NOT re-call the
// LLM — it replays the cached rules. The signature folds in file content, so editing a blind file re-learns.
export function hasLearnedMatchersFor(repo: string, sig: string): boolean {
  return _loadStore(_repoDir(repo)).learnedSigs.has(sig);
}
export function recordLearnedMatchers(repo: string, sig: string): void {
  const store = _loadStore(_repoDir(repo));
  if (store.learnedSigs.has(sig)) return;
  store.learnedSigs.add(sig);
  // SETTLING DIAGNOSTIC: a NEW learned-signature on a WARM run = a learning pass fired that shouldn't have (its
  // input set differs from any cached one) → key-adapters.json is rewritten → the coupling epoch bumps → the
  // answer cache misses. The sig prefix tells which pass: bare hex = matcher synth (learnKeyMatchers), "rc:" =
  // repository/receiver classifier, "ra:" = annotation classifier. A repo that keeps printing this never settles.
  if (process.env.SEAM_FP_DEBUG) process.stderr.write(`[key-store] +learnedSig ${sig.slice(0, 10)} → learnedSigs now ${store.learnedSigs.size} (WRITE key-adapters.json)\n`);
  try { ensureSeamGitignore(repo); _writeStore(_repoDir(repo)); } catch { /* read-only repo → in-memory only */ }
}

// All learned rules (repo FIRST, then shared), deduped by executable identity; records a usage-ledger hit.
export function loadMatchers(repo: string): KeyMatcher[] {
  const out: KeyMatcher[] = [], seen = new Set<string>();
  for (const [scope, dir] of [["repo", _repoDir(repo)], ["shared", _sharedDir()]] as const)
    for (const m of _loadStore(dir).rules) { const id = _id(m); if (seen.has(id)) continue; seen.add(id); recordAdapterUsed(_label(m), scope); out.push(m); }
  return out;
}

// All learned rules with their scope, PURE (no ledger side-effect) — for `seam-adapters`.
export function listMatchers(repo: string): { matcher: KeyMatcher; scope: "repo" | "shared" }[] {
  const out: { matcher: KeyMatcher; scope: "repo" | "shared" }[] = [];
  for (const [scope, dir] of [["repo", _repoDir(repo)], ["shared", _sharedDir()]] as const)
    for (const m of _loadStore(dir).rules) out.push({ matcher: m, scope });
  return out;
}

// Merge newly-learned rules into the repo store (dedup by identity) and persist the unified file.
export function persistMatchers(repo: string, matchers: KeyMatcher[]): void {
  if (!matchers.length) return;
  const store = _loadStore(_repoDir(repo));
  const have = new Set(store.rules.map(_id));
  let added = 0;
  for (const m of matchers) if (!have.has(_id(m))) { have.add(_id(m)); store.rules.push(m); recordAdapterLearned(_label(m)); added++; }
  // SETTLING DIAGNOSTIC: NEW rules on a warm run = a learn pass produced a rule not already stored. `added=0`
  // means this call was a no-op that STILL rewrites the file (dedup found nothing new) — harmless but noted.
  if (process.env.SEAM_FP_DEBUG) process.stderr.write(`[key-store] persistMatchers +${added} rule(s) → rules now ${store.rules.length} (WRITE key-adapters.json)\n`);
  try { ensureSeamGitignore(repo); _writeStore(_repoDir(repo)); } catch { /* read-only repo → in-memory only */ }
}

// ── FILES (per-file literal keys) ────────────────────────────────────────────────────────────────────
// True if EITHER store holds any per-file key adapter.
export function hasKeyCache(repo: string): boolean {
  return _loadStore(_repoDir(repo)).files.size > 0 || _loadStore(_sharedDir()).files.size > 0;
}

// The keys for a content-key — repo-local FIRST, then shared. `{hit,keys}` shape kept for llm_key_index.
export function cachedFileKeys(repo: string, key: string): { hit: boolean; keys: KeyHit[] } {
  for (const [scope, dir] of [["repo", _repoDir(repo)], ["shared", _sharedDir()]] as const) {
    const a = _loadStore(dir).files.get(key);
    // An EMPTY entry is a cluster-COVERED marker (a non-rep member whose keys come from the learned rule, not
    // a per-file synth) — it's a real cache HIT (so a warm run skips the file) but grounds nothing, so it is
    // NOT a "used adapter" for the ledger.
    if (a) { if (a.keys.length) recordAdapterUsed(a.name, scope); return { hit: true, keys: a.keys }; }
  }
  return { hit: false, keys: [] };
}

export function persistFileKeys(repo: string, key: string, adapter: KeyAdapter): void {
  recordAdapterLearned(adapter.name);
  const store = _loadStore(_repoDir(repo));
  const fresh = !store.files.has(key);
  store.files.set(key, adapter);
  // SETTLING DIAGNOSTIC: a NEW per-file entry on a warm run = a floor-blind file that was NOT already cached
  // (the cluster-covered marker missed) → key-adapters.json grows → epoch bumps. If this prints on every warm
  // run, blind files aren't being cached completely (the cap-slide, now fixed) — the `key` is `<file> <sha1>`.
  if (fresh && process.env.SEAM_FP_DEBUG) process.stderr.write(`[key-store] +file ${key.split(" ")[0]} keys=${adapter.keys.length} → files now ${store.files.size} (WRITE key-adapters.json)\n`);
  try { ensureSeamGitignore(repo); _writeStore(_repoDir(repo)); } catch { /* read-only repo → in-memory only */ }
}

// All per-file key adapters (repo + shared), non-empty — for `seam-adapters`.
export function listKeyAdapters(repo: string): { key: string; adapter: KeyAdapter; scope: "repo" | "shared" }[] {
  const out: { key: string; adapter: KeyAdapter; scope: "repo" | "shared" }[] = [];
  for (const [scope, dir] of [["repo", _repoDir(repo)], ["shared", _sharedDir()]] as const)
    for (const [k, v] of _loadStore(dir).files) if (v.keys.length) out.push({ key: k, adapter: v, scope });
  return out;
}

// ── PROMOTE (repo → shared) ──────────────────────────────────────────────────────────────────────────
// Promote a repo-learned adapter (RULE or per-file) by its friendly name into the shared store.
export function promoteKeyAdapter(repo: string, name: string): { ok: boolean; adapter?: KeyAdapter } {
  const repoStore = _loadStore(_repoDir(repo)), shared = _loadStore(_sharedDir());
  const rule = repoStore.rules.find((m) => (m.name ?? matcherKey(m)) === name);
  if (rule) {
    if (!shared.rules.some((m) => _id(m) === _id(rule))) shared.rules.push(rule);
    try { _writeStore(_sharedDir()); return { ok: true }; } catch { return { ok: false }; }
  }
  for (const [k, v] of repoStore.files) {
    if (v.name !== name) continue;
    shared.files.set(k, v);
    try { _writeStore(_sharedDir()); return { ok: true, adapter: v }; } catch { return { ok: false }; }
  }
  return { ok: false };
}

// Test/CI hooks — one in-memory store, two historical reset names kept for callers.
export function _resetKeyStoreMem(): void { _mem.clear(); }
export const _resetMatcherCacheMem = _resetKeyStoreMem;
export const _resetKeyCacheMem = _resetKeyStoreMem;
export { _rel as KEY_STORE_REL };
