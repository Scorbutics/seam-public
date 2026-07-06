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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run_pass, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit, verbose } from "../../core/progress.js";

const PASS = registerPass({ tag: "discover-keys-batch", tier: "strong", note: "shared-key producer/consumer discovery (semantic, learn-once → .seam)" });
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { makeCtx, available, lang_for, _FUNCLIKE, _CLASS_KINDS, _NAME_KINDS } from "../atoms.js";
import { scan_file_keys, scannableForKeys } from "./adapters/index.js";
import { makeMaskCtx, lineOf } from "./adapters/util.js";
import { normPath } from "./adapters/http_route.js";
import { cachedFileKeys, persistFileKeys, hasKeyCache } from "./key_store.js";
import { hasMatcherCache, loadMatchers } from "./key_store.js";
import { learnKeyMatchers, applyMatchers } from "./key_matcher.js";
import { plausibleKeyValue, runMatcher } from "./key_ir.js";
import { clusterBlindFiles } from "./key_cluster.js";
import { COUPLING } from "./config.js";
import { EngineCtx } from "../engine_ctx.js";
import type { GroundingIndex, KeyHit } from "./types.js";

export interface KeyIndexOpts { llm?: boolean; augment?: boolean; model?: string; claudeBin?: string | null; scope?: string; scopeFiles?: Set<string> }

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

// FILE SNIPPET = the structural HEAD ⊕ the deep string-key windows. The per-file pass infers couplings two
// ways: (a) STRUCTURAL ones near the top — a class/model decl, a controller, imports (ActiveRecord
// `Payment.where`, an implicit Rails route) — and (b) STRING-KEYED ones (queue/event/cache/route/config) at a
// call site with a string-literal arg, which can sit ANYWHERE in the file. The old "first 4 KB" caught (a)
// but truncated (b) past the cut. So we ALWAYS keep the head (preserves (a)) and ADD the windows around the
// string-key sites (closes (b)'s recall hole), dropping only the inert middle. Comment-masked so a literal in
// a comment isn't a site.
const _ARG_STRING = /[(,]\s*['"`]/g;   // a string literal as a call argument
export function candidatePassages(text: string, maxChars: number, context = 3, headChars = 700): string {
  const lines = text.split("\n");
  const code = makeMaskCtx(text).comments;
  const sites = new Set<number>();
  let m: RegExpExecArray | null; _ARG_STRING.lastIndex = 0;
  while ((m = _ARG_STRING.exec(code)) !== null) sites.add(lineOf(code, m.index));
  // window 0 = the HEAD (structural context); subsequent windows = string-key sites beyond it
  let headEnd = 0, hc = 0;
  while (headEnd < lines.length - 1 && hc < headChars) { hc += lines[headEnd].length + 1; headEnd++; }
  const windows: [number, number][] = [[0, headEnd]];
  for (const s of [...sites].sort((a, b) => a - b)) {
    const lo = Math.max(0, s - context), hi = Math.min(lines.length - 1, s + context);
    const last = windows[windows.length - 1];
    if (lo <= last[1] + 1) last[1] = Math.max(last[1], hi);   // merge into the head / previous window
    else windows.push([lo, hi]);
  }
  let out = "", size = 0;
  for (const [lo, hi] of windows) {
    const block = (lo > 0 ? `… (line ${lo + 1})\n` : "") + lines.slice(lo, hi + 1).join("\n") + "\n";
    if (size + block.length > maxChars && size > 0) break;
    out += block; size += block.length;
  }
  return out;
}

// Batch-synthesize keys for the given (uncached) files — chunked by snippet size, one LLM call per chunk,
// each file's result persisted as a named KeyAdapter. Returns file → KeyHit[] (empty if the LLM found none).
async function _batchSynthesize(repo: string, files: { file: string; text: string; ck: string }[], opts: KeyIndexOpts): Promise<Map<string, KeyHit[]>> {
  const result = new Map<string, KeyHit[]>();
  let chunk: { file: string; text: string; ck: string; snippet: string }[] = [], size = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const prompt = _batchPrompt(chunk.map((c) => ({ file: c.file, snippet: c.snippet })));
    let byFile = new Map<string, KeyHit[]>();
    try { byFile = _parseBatch(run_pass(prompt, { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag })); }
    catch (e) { if (!(e instanceof LLMError)) throw e; }
    const defNames = await _definedNames(chunk);   // code symbols the model could be echoing as keys (full text)
    for (const c of chunk) {
      const keys = (byFile.get(c.file) ?? []).filter((h) => !defNames.has(h.value));   // drop code-symbol echoes
      result.set(c.file, keys); persistFileKeys(repo, c.ck, { ..._keyAdapterMeta(c.file, keys), keys });
    }
    chunk = []; size = 0;
  };
  for (const f of files) {
    const snippet = candidatePassages(f.text, PER_FILE);   // head ⊕ deep string-key windows (always ≥ the head)
    if (size + snippet.length > SNIPPET_CAP && chunk.length) await flush();
    chunk.push({ ...f, snippet }); size += snippet.length;
  }
  await flush();
  return result;
}

export async function llmKeyIndex(repo: string, opts: KeyIndexOpts = {}, ctx: EngineCtx = new EngineCtx()): Promise<GroundingIndex> {
  const augment = !!opts.augment || process.env.SEAM_KEY_AUGMENT === "1";
  // SCOPE: the per-file LLM synthesis is bounded to the anchor's MODULE (opts.scope, a repo-relative prefix),
  // not the whole repo — so a big monorepo costs the LLM only its relevant module, and other modules are
  // warmed LAZILY as the grow re-anchors into them. The deterministic floor + the learned matcher RULES still
  // ground repo-wide (applyMatchers below is unscoped), so a coupling whose other side sits in an unscanned
  // module still grounds via a rule. `SEAM_WARM_ADAPTERS=1` (or an empty scope) restores the whole-repo pass.
  const scope = process.env.SEAM_WARM_ADAPTERS === "1" ? "" : (opts.scope ?? "");
  // FOOTPRINT-SCOPED (opts.scopeFiles, set from a floor pre-grow's reached files): bound the per-file LLM
  // synthesis to exactly the flow's files — across every module the grow spans — instead of the anchor's
  // module directory. The floor scan below stays repo-wide so producers in any module still ground.
  const inScope = opts.scopeFiles
    ? (rel: string): boolean => opts.scopeFiles!.has(rel)
    : (rel: string): boolean => !scope || rel === scope.slice(0, -1) || rel.startsWith(scope);
  const cacheKey = `${repo}::${opts.llm ? "llm" : "det"}::${augment ? "aug" : "blind"}::${opts.scopeFiles ? "fp" + opts.scopeFiles.size : scope}`;
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
  const blindCandidates: { file: string; text: string; ck: string }[] = [];   // floor-blind in-scope → clustered below
  // The COLLECTION cap must bound COST, not SETTLING. Capping which blind files get COLLECTED (and thus cached
  // as cluster-covered below) made the flywheel SLIDE: with >cap footprint-blind files, cold caches the first
  // `cap`, the warm run finds those cached (skip) and slides to the NEXT `cap` — so key-adapters.json grows every
  // run for ceil(blind/cap) rounds, and each write bumps the coupling epoch → the answer cache NEVER settles on a
  // big repo (Acme: hundreds of blind files → never a warm READ). A SCOPED pass (footprint via
  // scopeFiles, or a module prefix) is already bounded by its scope — so collect ALL of it in ONE round and let
  // it settle. Only the truly UNSCOPED whole-repo warm-up (SEAM_WARM_ADAPTERS / empty scope) keeps the cost cap.
  // The LLM SEND is still bounded downstream (blindFiles cap + the matcher snippet cap), so cost is unchanged.
  const unscoped = !opts.scopeFiles && !scope;
  let blindHit = 0, blindScanned = 0;   // settling census (SEAM_FP_DEBUG): floor-blind files already cached vs newly collected
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, scannableForKeys)) {
    const floor = floorByRel.get(rel) ?? scan_file_keys(rel, text);
    floorOf.set(rel, new Set(floor.map((h) => `${h.kind} ${h.value}`)));
    if (!inScope(rel)) continue;                     // out-of-module → no per-file LLM (floor + rules still ground it)
    // BRIDGE file: floor-covered ONLY by a DI `binding` (a service wrapper like a Vue plugin) — it almost
    // always ALSO does I/O the floor can't read (a composed/templated route). Without this it's "floor-covered
    // → skipped", so the I/O is never examined and a consumer-anchored cross-stack grow stalls at the wrapper
    // (the globex bookingService GAP B). NARROW (binding-only) so it does NOT re-augment member_access-keyed
    // db files. Treated as blind below → its non-binding keys (the route) get discovered, the binding stays floor.
    const isBridge = floor.length > 0 && floor.every((h) => h.kind === "binding");
    if (floor.length && !augment && !isBridge) continue;   // floor covers + not augmenting/bridge → leave to shared_key_index
    const ck = `${rel} ${createHash("sha1").update(text).digest("hex")}`;
    const disk = cachedFileKeys(repo, ck);
    const blindish = !floor.length || isBridge;
    if (blindish) (disk.hit ? blindHit++ : blindScanned++);
    if (disk.hit) { llmKeysOf.set(rel, disk.keys); continue; }
    if (blindish) { if (!unscoped || blindCandidates.length < COUPLING.keyBudget) blindCandidates.push({ file: rel, text, ck }); continue; }   // blind OR bridge → discover its (other) keys (scoped: collect ALL → settle; unscoped: cost-capped)
    if (opts.llm && ctx.keyBudget > 0) { ctx.keyBudget -= 1; toSynth.push({ file: rel, text, ck }); }   // augment floor-COVERED file (not clustered — its keys are file-specific gaps)
  }
  // STRUCTURAL pre-clustering: floor-blind files sharing a data-access SHAPE (`prisma.<x>.<verb>()`) are one
  // pattern — LLM ONLY a representative per cluster; the rest ground via the learned rule (applyMatchers,
  // repo-wide, deterministic). Cuts the LLM INPUT (vs the cache, which only avoids re-paying it). Degrades to
  // one-cluster-per-file when tree-sitter is unavailable. The non-rep members are reported, not silently dropped.
  const clusters = await clusterBlindFiles(blindCandidates);
  const collapsed = blindCandidates.length - clusters.length;
  if (collapsed > 0) emit(`Clustered ${blindCandidates.length} floor-blind file(s) → ${clusters.length} pattern representative(s) (−${collapsed} covered by shared shape)…`);
  // SETTLING CENSUS (SEAM_FP_DEBUG): on a truly WARM run this MUST read `new=0` (every floor-blind file already
  // cached) — then no learning fires, key-adapters.json is untouched, the epoch holds, the answer cache hits.
  // `new>0` on a repeat run pinpoints the leak: those files were NOT cached last run (a cap-slide remnant, or a
  // per-file synth that returned keys but whose ck didn't get a marker). `scope` shows the discovery is bounded.
  if (process.env.SEAM_FP_DEBUG) process.stderr.write(`[coupling] scope=${opts.scopeFiles ? `fp:${opts.scopeFiles.size}` : (scope || "repo")} | floor-blind: ${blindHit} cached-hit, ${blindScanned} NEW → ${blindCandidates.length} to cluster → ${clusters.length} rep(s)\n`);
  // The cluster is the unit of LLM work: ONE rep per cluster → the MATCHER pass (pass 4) learns the SHAPE and
  // grounds it repo-wide. The per-file `discover-keys-batch` extraction on the SAME reps is OFF by default —
  // SEAM_KEY_AUDIT (cal.com) shows it adds ZERO unique grounded couplings (the matcher pass covers them all),
  // i.e. it was a redundant SECOND LLM pass over the same files. `SEAM_PER_FILE_KEYS=1` restores it (the
  // framework-agnostic regeneration opt-in / the literal-axis fallback).
  const perFileKeys = process.env.SEAM_PER_FILE_KEYS === "1";
  let shapelessSkipped = 0;
  for (const c of clusters) {
    // NO SUSPECTED EDGE: a floor-blind file with no data-access shape (a DTO/serializer/entity) has nothing for
    // the flywheel to learn — skip the LLM, but CACHE it covered so a warm run doesn't re-scan it (it settles).
    if (!c.shaped) {
      for (const m of c.members) persistFileKeys(repo, m.ck, { name: "no-boundary-shape", description: "floor-blind but no data-access shape — no edge to learn", keys: [] });
      shapelessSkipped += c.members.length;
      continue;
    }
    if (blindFiles.length < COUPLING.keyBudget) blindFiles.push({ file: c.rep.file, text: c.rep.text });   // matcher synth: one rep per pattern
    if (!opts.llm) continue;
    if (perFileKeys && ctx.keyBudget > 0) { ctx.keyBudget -= 1; toSynth.push(c.rep); }                      // per-file pass (opt-in) — persists the rep's keys
    // cache the cluster MEMBERS as covered so a warm run skips them (the rule grounds them). The rep is cached
    // by the per-file pass when on; matcher-only → cache the rep too (its keys come from the rule).
    for (const m of c.members) if (!(perFileKeys && m.ck === c.rep.ck))
      persistFileKeys(repo, m.ck, { name: `cluster-covered`, description: `keys via cluster rule (${c.signature || "shapeless"})`, keys: [] });
  }
  if (shapelessSkipped) emit(`Skipped ${shapelessSkipped} floor-blind file(s) with no data-access shape (no suspected edge to learn)…`);
  if (verbose() && collapsed > 0)
    process.stderr.write(`[coupling] clustered blind files by shape:\n${clusters.filter((c) => c.members.length > 1).map((c) => `   · ${c.signature || "(shapeless)"} ×${c.members.length} → rep ${c.rep.file}`).join("\n")}\n`);
  // pass 2 — one batched LLM call per chunk for the uncached files
  if (toSynth.length) {
    emit(`Deducing data-coupling keys for ${toSynth.length} floor-blind file(s) via LLM (batched)…`);
    if (verbose()) process.stderr.write(`[coupling] ${toSynth.length} floor-blind file(s) → LLM (scope: ${scope || "repo"}; cap SEAM_KEY_BUDGET=${COUPLING.keyBudget}):\n${toSynth.map((t) => `   · ${t.file}`).join("\n")}\n`);
    for (const [f, keys] of await _batchSynthesize(repo, toSynth, opts)) llmKeysOf.set(f, keys);
  }

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
  // CHAIN the per-file pass → the matcher synth: feed it the files where couplings were actually FOUND
  // (the per-file hits) FIRST, then other blind files. Otherwise the synth sees an arbitrary first-N
  // alphabetical slice (on a Next.js app: the `app/api/...` routes, never the component files holding the
  // recurring localStorage/cache pattern) and generalises nothing — leaving the per-file pass to list those
  // keys literally. Generalising from where the couplings ARE is what moves a recurring key from the
  // (LLM-per-file) `files` tier up to the (cached, deterministic, repo-wide) `rules` tier.
  const matcherFiles: { file: string; text: string }[] = [];
  const _mseen = new Set<string>();
  for (const [file, keys] of llmKeysOf) {
    if (!keys.length || _mseen.has(file)) continue;
    try { matcherFiles.push({ file, text: readFileSync(join(repo, file), "utf-8") }); _mseen.add(file); } catch { /* unreadable → skip */ }
  }
  for (const f of blindFiles) if (!_mseen.has(f.file)) matcherFiles.push(f);
  // SETTLE warm runs: only LEARN when this run surfaced NEW blind files. With every cluster member cached
  // (blindCandidates empty) the rep set is empty, so a re-learn would feed the learner an unstable cached-rep
  // subset → a needless LLM call each run. No new blind work → the rules are already learned; replay them.
  // The three LEARNING passes are INDEPENDENT (matcher synth reads blind snippets; the two classifiers read the
  // receiver / annotation inventories) and each only APPENDS to the matcher store (persistMatchers = fresh
  // load-merge-write, dedup by id → concurrent-safe in single-threaded JS). Run them concurrently: on the
  // `claude -p`/copilot path run_pass_async overlaps the subprocesses, so the cold cost is the SLOWEST pass
  // (the matcher synth+retry) instead of their SUM — the sequential `synth(43) + recv(21) + annot(13)` the
  // globex run showed. (The host-bus/MCP path serves serially, so it stays correct, just doesn't overlap.)
  const { classifyAndPersistRepositories, classifyAndPersistAnnotations } = await import("./receiver_class.js");
  await Promise.all([
    blindCandidates.length ? learnKeyMatchers(repo, matcherFiles.length ? matcherFiles : blindFiles, opts, ctx) : Promise.resolve([]),
    classifyAndPersistRepositories(repo, opts, ctx),   // `repository` matchers for database-classified receivers (custom 2-part data layers)
    classifyAndPersistAnnotations(repo, opts, ctx),    // `annotation` matchers for custom route/queue/event annotations a hardcoded set misses
  ]);
  const matchers = loadMatchers(repo);                   // cached/shared ∪ what we just learned (one source)
  const matchersIdx: GroundingIndex = matchers.length ? await applyMatchers(repo, matchers) : new Map();

  for (const sub of [filesIdx, matchersIdx]) for (const [k, v] of sub) {   // union both axes into the result
    if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
    idx.get(k)!.producers.push(...v.producers); idx.get(k)!.consumers.push(...v.consumers);
  }
  // pass 5 — DANGLING COUNTERPART reach (footprint-scoped only): a key a footprint file PRODUCES that nothing
  // CONSUMES (or vice-versa) is a half-grounded boundary — the cross-stack case (a backend producer whose UI
  // consumer sits OUTSIDE the footprint, so footprint-scoping never discovered it). Use the dangling literal
  // to SEED the other module's file that holds it (the FE wrapper carries the literal even when the component
  // call site reaches it through indirection), LLM-discover THOSE, and merge — so the counterpart grounds and
  // crossBoundary can pull it in. Dangling-only + grep-bounded → cheap; baked into the cached idx (warm-safe).
  // TEMPORARILY DISABLED by default: the dangling-counterpart reach is slow on real repos and not landing the
  // counterpart reliably (the cross-stack recall it's meant to add). Off until that's fixed; opt back in with
  // SEAM_DANGLING_REACH=1 (the regression tests set it). The rest of pass 5 (the bounded grep-seed) stays intact.
  if (process.env.SEAM_DANGLING_REACH === "1" && opts.scopeFiles && opts.llm && ctx.keyBudget > 0)
    for (const [k, v] of await _reachDanglingCounterparts(repo, idx, opts, ctx)) {
      if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
      idx.get(k)!.producers.push(...v.producers); idx.get(k)!.consumers.push(...v.consumers);
    }
  // AUDIT (SEAM_KEY_AUDIT=1): how much of the GROUNDED coupling does each LLM pass uniquely enable? Decides
  // whether the per-file pass still earns its keep now the matcher shapes cover the generalisable cases.
  if (process.env.SEAM_KEY_AUDIT) await _auditKeySources(repo, ctx, filesIdx, matchersIdx, matchers.length);

  ctx.llmKey.set(cacheKey, idx);
  return idx;
}

// DANGLING COUNTERPART reach (pass 5). A key with a SCOPE-file on ONE side and NOTHING on the other (across
// the floor ⊕ the footprint LLM idx) is a cross-module boundary the footprint scope cut in half. Grep the
// literal → the file(s) in another module that hold it (out of the footprint) → discover them (cluster +
// per-file LLM + learn rules, reusing the machinery) → return the grounding delta so the counterpart side
// appears in the index. ONE hop, dangling-only, grep- and budget-bounded.
async function _reachDanglingCounterparts(repo: string, idx: GroundingIndex, opts: KeyIndexOpts, ctx: EngineCtx): Promise<GroundingIndex> {
  const scope = opts.scopeFiles!;
  const { floor_base_index, grepFiles } = await import("./index.js");
  const floor = floor_base_index(repo, SKIP_DIRS, ctx);
  const inScope = (a: { file: string }) => scope.has(a.file);
  // dangling literals: a scope file is the ONLY side present (no counterpart anywhere)
  const dangling = new Map<string, { kind: string; value: string }>();
  for (const [k, v] of idx) {
    const fl = floor.get(k) ?? { producers: [], consumers: [] };
    const producers = [...v.producers, ...fl.producers], consumers = [...v.consumers, ...fl.consumers];
    const sep = k.indexOf(" "); const kind = k.slice(0, sep), value = k.slice(sep + 1);
    if (!plausibleKeyValue(value)) continue;
    if (!consumers.length && producers.some(inScope)) dangling.set(value, { kind, value });        // produced here, consumed nowhere
    else if (!producers.length && consumers.some(inScope)) dangling.set(value, { kind, value });   // consumed here, produced nowhere
  }
  if (!dangling.size) return new Map();
  // grep each dangling literal → candidate counterpart files OUTSIDE the footprint (the wrapper that carries it).
  // BOUNDED: a DISTINCTIVE coupling key appears in FEW files (a producer + a consumer); a literal that greps to
  // many is a generic word, NOT a cross-module coupling — skip it (else 37 keys × hundreds = the 717 explosion).
  const MAX_PER_KEY = 12;   // a dangling literal in >12 files is too generic to be a distinctive counterpart
  const CAND_CAP = 40;      // hard cap on total counterpart candidates across all dangling keys
  const cands = new Map<string, { file: string; text: string; ck: string }>();
  outer: for (const d of [...dangling.values()].slice(0, COUPLING.keyBudget)) {
    const hits = grepFiles(repo, d.value);
    if (hits.length > MAX_PER_KEY) continue;   // non-distinctive literal → not a real cross-module key
    for (const f of hits) {
      if (cands.size >= CAND_CAP) break outer;
      if (scope.has(f) || cands.has(f) || !scannableForKeys(f)) continue;
      let text: string; try { text = readFileSync(join(repo, f), "utf-8"); } catch { continue; }
      cands.set(f, { file: f, text, ck: `${f} ${createHash("sha1").update(text).digest("hex")}` });
    }
  }
  if (!cands.size) return new Map();
  emit(`Reaching ${cands.size} cross-module counterpart file(s) for ${dangling.size} dangling key(s) via LLM…`);
  if (verbose()) process.stderr.write(`[coupling] dangling-counterpart reach: ${dangling.size} dangling key(s) → ${cands.size} candidate(s):\n${[...cands.keys()].slice(0, 25).map((f) => `   · ${f}`).join("\n")}\n`);
  // discover the counterparts (cluster → per-file LLM → learn rules), caching the whole cluster as before
  const candList = [...cands.values()];
  const toSynth: typeof candList = [];
  for (const c of await clusterBlindFiles(candList)) {
    if (!c.shaped) { for (const m of c.members) persistFileKeys(repo, m.ck, { name: "no-boundary-shape", description: "no data-access shape — no edge to learn", keys: [] }); continue; }   // no suspected edge → skip the LLM
    if (ctx.keyBudget <= 0) break;
    ctx.keyBudget -= 1; toSynth.push(c.rep);
    for (const m of c.members) if (m.ck !== c.rep.ck)
      persistFileKeys(repo, m.ck, { name: "cluster-covered", description: `keys via cluster rule (${c.signature || "shapeless"})`, keys: [] });
  }
  const counterKeys = await _batchSynthesize(repo, toSynth, opts);
  await learnKeyMatchers(repo, toSynth.map((t) => ({ file: t.file, text: t.text })), opts, ctx);
  const matchers = loadMatchers(repo);
  const delta: GroundingIndex = new Map();
  const add = (kind: string, value: string, file: string, line: number, produces: boolean) => {
    if (!plausibleKeyValue(value)) return;
    const k = `${kind} ${value}`;
    if (!delta.has(k)) delta.set(k, { producers: [], consumers: [] });
    (produces ? delta.get(k)!.producers : delta.get(k)!.consumers).push({ file, line });
  };
  for (const [file, keys] of counterKeys) for (const h of keys) add(h.kind, h.value, file, h.line, h.produces);
  for (const c of candList) for (const m of matchers) for (const h of await runMatcher(m, c.file, c.text)) add(h.kind, h.value, c.file, h.line, h.produces);
  return delta;
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
