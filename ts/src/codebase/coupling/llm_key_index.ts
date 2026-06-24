// REPO-WIDE LLM KEY INDEX — the framework-key axis's repo-wide grounding, the piece that makes Seam
// FRAMEWORK-AGNOSTIC. The deterministic adapters build shared_key_index for KNOWN frameworks; this fills
// the gaps with an LLM that DEDUCES keys, then grounds them by cross-site co-occurrence (a key couples
// only where the same literal independently appears at a producer AND a consumer — so a wrong deduction
// that doesn't co-occur is dropped; no human validation needed).
//
// TWO improvements over the per-file fallback:
//  • BATCHED — all candidate files go in ONE prompt per chunk (a char budget), collapsing the serial
//    fan-out (N calls → ~ceil(N/chunk) calls).
//  • PER-KEY RECONCILIATION — a file's LLM keys are emitted MINUS the ones the deterministic floor
//    already produced. So a PARTIAL/incomplete adapter is COMPLETED key-by-key (the LLM augments only the
//    floor's gaps, never duplicating a covered key). Reconciliation is ADDITIVE: it fills gaps, it does
//    not delete/correct a wrong floor key (the floor is trusted high-precision).
//  • AUGMENT mode (`opts.augment` / SEAM_KEY_AUGMENT=1) — also run the LLM on floor-COVERED files to find
//    their missed keys (the partial-adapter use case). Default OFF: only floor-BLIND files (cheap fallback).
//
// LAZY + cached: results persist to `.seam/key-adapters.json` (LLM once → deterministic forever; CI warm-up
// commits it). A normal det run with no `.seam/` does zero work.
import { createHash } from "node:crypto";
import { run_pass, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit } from "../../core/progress.js";

const PASS = registerPass({ tag: "discover-keys-batch", tier: "strong", note: "shared-key producer/consumer discovery (semantic, learn-once → .seam)" });
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { makeCtx, available, lang_for, _FUNCLIKE, _CLASS_KINDS, _NAME_KINDS } from "../atoms.js";
import { scan_file_keys, scannableForKeys } from "./adapters/index.js";
import { normPath } from "./adapters/http_route.js";
import { cachedFileKeys, persistFileKeys, hasKeyCache } from "./key_store.js";
import { hasMatcherCache, loadMatchers } from "./key_store.js";
import { learnKeyMatchers, applyMatchers } from "./key_matcher.js";
import { plausibleKeyValue } from "./key_ir.js";
import { COUPLING } from "./config.js";
import { EngineCtx } from "../engine_ctx.js";
import type { GroundingIndex, KeyHit } from "./types.js";

export interface KeyIndexOpts { llm?: boolean; augment?: boolean; model?: string; claudeBin?: string | null }

const SNIPPET_CAP = COUPLING.snippetCap;
const PER_FILE = COUPLING.perFile;
// the repo-wide LLM-key index (ctx.llmKey) + the run budget (ctx.keyBudget) now live on the EngineCtx —
// resetLlmKeyBudget() is gone; a fresh ctx is a clean slate.

// LLM free-text kind vocab → registered adapter kinds (same map discover_keys uses).
const _KIND_ALIASES: Record<string, string> = { route: "http-route", endpoint: "http-route", http: "http-route", url: "http-route", path: "http-route" };
const _canon = (k: string): string => _KIND_ALIASES[k.toLowerCase()] ?? k;

function _batchPrompt(files: { file: string; snippet: string }[]): string {
  const blocks = files.map((f) => `=== FILE: ${f.file} ===\n${f.snippet}`).join("\n\n");
  return `You are finding DATA-FLOW couplings carried by a SHARED KEY — an identifier a file shares with
OTHER files that no import/call connects: a DB table, a queue/topic, an event name, a cache key, an HTTP
route path. NOT ordinary imports/calls. Analyse EACH file below independently.

${blocks}

For every shared key with CONCRETE textual evidence, output one object. Do NOT invent keys — only ones
literally present. A wrong guess is worse than silence. The value MUST be a SPECIFIC IDENTIFIER (a
table/topic/event/route/cache name) — NEVER a common word, prose, a sentence fragment, or a generic token
like "the"/"data"/"value": a key that is not a distinctive name couples unrelated files by coincidence.
  file  — the FILE header path it came from
  kind  — db-table | queue | event | route | cache | key
  value — the literal name (table/topic/event/route/cache-key string)
  role  — "produces" if the file WRITES/EMITS/PUBLISHES it, "consumes" if it READS/SUBSCRIBES/HANDLES it

Return a JSON array (empty if none):
[{"id":"k1","file":"<path>","kind":"db-table","value":"payments","role":"produces"}]
`;
}

function _parseBatch(out: Map<string, any>): Map<string, KeyHit[]> {
  const byFile = new Map<string, KeyHit[]>();
  for (const obj of out.values()) {
    if (!obj || typeof obj !== "object") continue;
    const file = String(obj.file ?? "").trim();
    const kind = _canon(String(obj.kind ?? "").trim());
    let value = String(obj.value ?? "").trim();
    if (!file || !kind || !value) continue;
    if (kind === "http-route") value = normPath(value);
    if (!plausibleKeyValue(value)) continue;   // drop generic/prose values (e.g. "the") the LLM hallucinated as keys
    const produces = String(obj.role ?? "").trim().toLowerCase().startsWith("produc");
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ kind, value, line: 0, produces });
  }
  return byFile;
}

// Derive a learned KEY-adapter's name + description (per-file facts don't generalize like a carrier
// method rule, so the name is file-derived, not LLM-given; the description summarises the deduced keys).
function _keyAdapterMeta(file: string, keys: KeyHit[]): { name: string; description: string } {
  const base = file.split("/").pop()!.replace(/\.[^.]+$/, "");
  const name = `${base}${keys[0] ? "-" + keys[0].kind : ""}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const description = keys.slice(0, 4).map((k) => `${k.produces ? "produces" : "consumes"} ${k.kind} ${k.value}`).join("; ") || "no keys";
  return { name, description };
}

// SYMBOL-COLLISION guard: the per-file LLM ECHOES code symbols it sees in the file (a class `MessageBean`,
// a method `validateDocumentCount`) and proposes them as data keys — they then "ground" because the model
// is consistently wrong across files. A real data key (a table/topic/event NAME) is NOT a code identifier
// defined in the source. So we collect the class/method/function names DEFINED in the synthesized files
// (the only symbols the model can echo, since that's the text it was shown) and drop any proposed key whose
// value is one of them. Structural + language-agnostic (tree-sitter), high precision (real keys aren't defs).
async function _definedNames(files: { file: string; text: string }[]): Promise<Set<string>> {
  const names = new Set<string>();
  if (!available()) return names;
  for (const f of files) {
    const lang = lang_for(f.file);
    if (!lang) continue;
    let ctx; try { ctx = await makeCtx(f.text, lang); } catch { continue; }
    if (!ctx) continue;
    for (const n of ctx.collect(ctx.root, (k: string) => _FUNCLIKE.has(k) || _CLASS_KINDS.has(k)))
      for (const c of ctx.children(n)) if (_NAME_KINDS.has(c.type)) { names.add(ctx.text(c)); break; }
  }
  return names;
}

// Batch-synthesize keys for the given (uncached) files — chunked by snippet size, one LLM call per chunk,
// each file's result persisted as a named KeyAdapter. Returns file → KeyHit[] (empty if the LLM found none).
async function _batchSynthesize(repo: string, files: { file: string; text: string; ck: string }[], opts: KeyIndexOpts): Promise<Map<string, KeyHit[]>> {
  const result = new Map<string, KeyHit[]>();
  let chunk: { file: string; text: string; ck: string }[] = [], size = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const prompt = _batchPrompt(chunk.map((c) => ({ file: c.file, snippet: c.text.slice(0, PER_FILE) })));
    let byFile = new Map<string, KeyHit[]>();
    try { byFile = _parseBatch(run_pass(prompt, { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag })); }
    catch (e) { if (!(e instanceof LLMError)) throw e; }
    const defNames = await _definedNames(chunk);   // code symbols the model could be echoing as keys
    for (const c of chunk) {
      const keys = (byFile.get(c.file) ?? []).filter((h) => !defNames.has(h.value));   // drop code-symbol echoes
      result.set(c.file, keys); persistFileKeys(repo, c.ck, { ..._keyAdapterMeta(c.file, keys), keys });
    }
    chunk = []; size = 0;
  };
  for (const f of files) {
    const len = Math.min(f.text.length, PER_FILE);
    if (size + len > SNIPPET_CAP && chunk.length) await flush();
    chunk.push(f); size += len;
  }
  await flush();
  return result;
}

export async function llmKeyIndex(repo: string, opts: KeyIndexOpts = {}, ctx: EngineCtx = new EngineCtx()): Promise<GroundingIndex> {
  const augment = !!opts.augment || process.env.SEAM_KEY_AUGMENT === "1";
  const cacheKey = `${repo}::${opts.llm ? "llm" : "det"}::${augment ? "aug" : "blind"}`;
  if (ctx.llmKey.has(cacheKey)) return ctx.llmKey.get(cacheKey)!;
  const idx: GroundingIndex = new Map();
  if (!opts.llm && !hasKeyCache(repo) && !hasMatcherCache(repo)) { ctx.llmKey.set(cacheKey, idx); return idx; }

  // pass 1 — gather each file's deterministic floor keys + decide which files need the LLM
  const floorOf = new Map<string, Set<string>>();     // file → `${kind} ${value}` the floor already produced
  const llmKeysOf = new Map<string, KeyHit[]>();       // file → cached LLM keys
  const toSynth: { file: string; text: string; ck: string }[] = [];
  const blindFiles: { file: string; text: string }[] = [];   // floor-blind files → matcher-rule synthesis candidates
  // REUSE the floor scan (computed once per run, disk-cached) instead of re-scanning every file here — that
  // was a full DUPLICATE repo scan (≈ the whole assemble cost). floorByRel.get(rel) === scan_file_keys(rel,
  // text) by construction, so behaviour is identical; `??` is a defensive fallback.
  const { floorContributions } = await import("./index.js");
  const floorByRel = new Map<string, KeyHit[]>(floorContributions(repo, SKIP_DIRS, ctx).map((c) => [c.rel, c.data.keys]));
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, scannableForKeys)) {
    const floor = floorByRel.get(rel) ?? scan_file_keys(rel, text);
    floorOf.set(rel, new Set(floor.map((h) => `${h.kind} ${h.value}`)));
    if (!floor.length && blindFiles.length < COUPLING.keyBudget) blindFiles.push({ file: rel, text });
    if (floor.length && !augment) continue;          // floor covers + not augmenting → leave to shared_key_index
    const ck = `${rel} ${createHash("sha1").update(text).digest("hex")}`;
    const disk = cachedFileKeys(repo, ck);
    if (disk.hit) { llmKeysOf.set(rel, disk.keys); continue; }
    if (opts.llm && ctx.keyBudget > 0) { ctx.keyBudget -= 1; toSynth.push({ file: rel, text, ck }); }
  }
  // pass 2 — one batched LLM call per chunk for the uncached files
  if (toSynth.length) { emit(`Deducing data-coupling keys for ${toSynth.length} floor-blind file(s) via LLM (batched)…`); for (const [f, keys] of await _batchSynthesize(repo, toSynth, opts)) llmKeysOf.set(f, keys); }

  // pass 3 — PER-FILE LITERAL keys (the `files` axis): each file's LLM keys MINUS the ones its floor already
  // covered. Kept in its OWN sub-index so its grounding contribution can be audited vs the matcher pass.
  const filesIdx: GroundingIndex = new Map();
  for (const [file, keys] of llmKeysOf) {
    const floorSet = floorOf.get(file) ?? new Set<string>();
    for (const h of keys) {
      if (!plausibleKeyValue(h.value)) continue;            // filter junk already cached in .seam/ (no re-warm needed)
      if (floorSet.has(`${h.kind} ${h.value}`)) continue;   // floor already has this key → don't duplicate
      const k = `${h.kind} ${h.value}`;
      if (!filesIdx.has(k)) filesIdx.set(k, { producers: [], consumers: [] });
      (h.produces ? filesIdx.get(k)!.producers : filesIdx.get(k)!.consumers).push({ file, line: h.line });
    }
  }

  // pass 4 — the MATCHER flywheel (the `rules` axis): LEARN reusable adapter rules from the floor-blind files
  // (LLM, self-validated; no-op without opts.llm/budget), then apply ALL matchers (newly learned + cached/
  // shared) DETERMINISTICALLY across the repo. This is what makes a warm `.seam/` cover a learned framework.
  await learnKeyMatchers(repo, blindFiles, opts, ctx);   // persists survivors into the matcher store
  const matchers = loadMatchers(repo);                   // cached/shared ∪ what we just learned (one source)
  const matchersIdx: GroundingIndex = matchers.length ? await applyMatchers(repo, matchers) : new Map();

  for (const sub of [filesIdx, matchersIdx]) for (const [k, v] of sub) {   // union both axes into the result
    if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
    idx.get(k)!.producers.push(...v.producers); idx.get(k)!.consumers.push(...v.consumers);
  }
  // AUDIT (SEAM_KEY_AUDIT=1): how much of the GROUNDED coupling does each LLM pass uniquely enable? Decides
  // whether the per-file pass still earns its keep now the matcher shapes cover the generalisable cases.
  if (process.env.SEAM_KEY_AUDIT) await _auditKeySources(repo, ctx, filesIdx, matchersIdx, matchers.length);

  ctx.llmKey.set(cacheKey, idx);
  return idx;
}

// Compare the GROUNDED-key sets (a key with ≥1 producer AND ≥1 consumer, across the floor) with vs without
// each LLM pass — so we can see how many real couplings the per-file pass enables that the matcher pass does
// not (and vice-versa). Diagnostic only; emits to stderr under SEAM_KEY_AUDIT.
async function _auditKeySources(repo: string, ctx: EngineCtx, filesIdx: GroundingIndex, matchersIdx: GroundingIndex, ruleCount: number): Promise<void> {
  const { floor_base_index } = await import("./index.js");
  const floor = floor_base_index(repo, SKIP_DIRS, ctx);
  const merge = (...idxs: GroundingIndex[]): GroundingIndex => {
    const m: GroundingIndex = new Map();
    for (const ix of idxs) for (const [k, v] of ix) { if (!m.has(k)) m.set(k, { producers: [], consumers: [] }); m.get(k)!.producers.push(...v.producers); m.get(k)!.consumers.push(...v.consumers); }
    return m;
  };
  const grounded = (m: GroundingIndex): Set<string> => new Set([...m].filter(([, v]) => v.producers.length && v.consumers.length).map(([k]) => k));
  const gFloor = grounded(floor), gFull = grounded(merge(floor, filesIdx, matchersIdx));
  const gNoFiles = grounded(merge(floor, matchersIdx)), gNoMatchers = grounded(merge(floor, filesIdx));
  const uniqFiles = [...gFull].filter((k) => !gNoFiles.has(k));        // grounded couplings LOST if per-file pass removed
  const uniqMatchers = [...gFull].filter((k) => !gNoMatchers.has(k));  // …if matcher pass removed
  const w = (s: string) => process.stderr.write(`[key-audit] ${s}\n`);
  w(`grounded keys: floor=${gFloor.size}  floor+matchers=${gNoFiles.size}  floor+files=${gNoMatchers.size}  FULL=${gFull.size}`);
  w(`passes: rules(matchers)=${ruleCount}  per-file-key-entries=${filesIdx.size}`);
  w(`UNIQUE to per-file pass (lost if removed): ${uniqFiles.length}${uniqFiles.length ? ` → ${uniqFiles.slice(0, 25).join(", ")}` : ""}`);
  w(`UNIQUE to matcher pass (lost if removed): ${uniqMatchers.length}${uniqMatchers.length ? ` → ${uniqMatchers.slice(0, 25).join(", ")}` : ""}`);
}

// The ANCHOR's own LLM-deduced keys (its `proposed` for attach) — synthesized from the anchor FILE
// directly (cached by content-hash), reconciled against the file's deterministic floor so only the keys
// the floor MISSED are proposed. Unlike reading them out of the repo-wide index, this also covers a
// floor-COVERED anchor file whose anchored action still needs an LLM key (e.g. a Rails controller that
// touches a model AND serves a route). Cached → a warm `.seam` covers the anchor side offline too.
export async function anchorProposedKeys(
  repo: string, anchorFile: string, text: string,
  opts: KeyIndexOpts = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<KeyHit[]> {
  const floor = new Set(scan_file_keys(anchorFile, text).map((h) => `${h.kind} ${h.value}`));
  const ck = `${anchorFile} ${createHash("sha1").update(text).digest("hex")}`;
  let keys: KeyHit[];
  const disk = cachedFileKeys(repo, ck);
  if (disk.hit) keys = disk.keys;
  else if (opts.llm && ctx.keyBudget > 0) { ctx.keyBudget -= 1; keys = (await _batchSynthesize(repo, [{ file: anchorFile, text, ck }], opts)).get(anchorFile) ?? []; }
  else return [];
  return keys.filter((h) => plausibleKeyValue(h.value) && !floor.has(`${h.kind} ${h.value}`));   // plausible keys only; floor's gaps (line 0; collectAnchorKeys stamps source "llm")
}
