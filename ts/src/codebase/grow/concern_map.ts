// LEARNED PER-REPO CONCERN MAP — the side-concern taxonomy flywheel. Once per repo, an LLM labels each
// MODULE (module_scope root, top-dir fallback) against the CLOSED concern vocabulary (concerns.ts); the
// labels persist to `.seam/concern-map.json` keyed by a content hash of the module's file list + the
// vocabulary version, so a warm run applies them with NO LLM — deterministic forever (the key_matcher.ts
// flywheel pattern). At QUERY time the border auto-DROPs a candidate in a labelled side-concern module that
// bears no crossing (I4: a crossing-bearer is never dropped, so a wrong label can't sever a real edge).
//
// Grounding, not trust: an out-of-vocabulary label is discarded; offline / no backend → no new labels → the
// map is only what's cached (empty on a cold offline run) → no effect (I3); the stable-floor probe never
// learns (I5). LLM applied ONCE per module, cached — the CLAUDE.md "structure frames the question, the LLM
// judges the meaning (which concern), then it's deterministic" shape.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { run_pass_async, registerPass, available as llmAvailable } from "../../core/llm.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import { SEAM_DIR, ensureSeamGitignore } from "../coupling/seam_dir.js";
import { CONCERN_VOCAB_VERSION, CONCERN_LABELS, isConcernLabel, concernVocabList } from "./concerns.js";
import { moduleKey } from "./ubiquity.js";
import type { EngineCtx } from "../engine_ctx.js";

const PASS = registerPass({ tag: "concern-map", tier: "cheap", note: "label each module against the closed side-concern vocabulary (learn-once → .seam)" });
const SCHEMA = 1;
const _rel = `${SEAM_DIR}/concern-map.json`;

export type ConcernMap = Map<string, string>;   // moduleKey → concern label (real concerns only; `none` omitted)

const _mem = new Map<string, ConcernMap>();
export function _resetConcernMapMem(): void { _mem.clear(); }
export { _rel as CONCERN_MAP_REL };

const _hash = (s: string): string => createHash("md5").update(s).digest("hex").slice(0, 16);

interface DiskEntry { label: string; hash: string; }
interface Disk { schema: number; vocab: string; modules: Record<string, DiskEntry>; }

// moduleKey → its sorted repo-relative source files (the labelling signal + the drift hash).
function _modules(repo: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { rel } of walkFiles(repo, SKIP_DIRS, endsWithSourceExt)) {
    const k = moduleKey(repo, rel);
    (out.get(k) ?? out.set(k, []).get(k)!).push(rel);
  }
  for (const v of out.values()) v.sort();
  return out;
}

function _loadDisk(repo: string): Map<string, DiskEntry> {
  try {
    const j = JSON.parse(readFileSync(join(repo, _rel), "utf-8")) as Disk;
    if (j?.schema === SCHEMA && j.vocab === CONCERN_VOCAB_VERSION && j.modules) return new Map(Object.entries(j.modules));
  } catch { /* absent / unreadable → cold */ }
  return new Map();
}

function _writeDisk(repo: string, entries: Map<string, DiskEntry>): void {
  try {
    ensureSeamGitignore(repo);
    mkdirSync(join(repo, SEAM_DIR), { recursive: true });
    const modules: Record<string, DiskEntry> = {};
    for (const [k, v] of entries) modules[k] = v;
    writeFileSync(join(repo, _rel), JSON.stringify({ schema: SCHEMA, vocab: CONCERN_VOCAB_VERSION, modules }, null, 2));
  } catch { /* read-only repo → in-memory only (still applies this run) */ }
}

function _prompt(mods: { i: number; module: string; files: string[] }[]): string {
  const FILE_CAP = 12;
  return [
    "You are labelling code MODULES by their SIDE-CONCERN, for an intent-focused code map. A SIDE-CONCERN is",
    "shared machinery a feature triggers along the way but is NOT what any feature is about (logging, audit,",
    "notifications…). It is NOT a peer BUSINESS DOMAIN (billing, catalog — those are `none`: a real subject,",
    "not a concern) and NOT a feature's own mechanism (`none`). Label each module with the SINGLE best-matching",
    "concern from this CLOSED list, or `none`:",
    concernVocabList(),
    "",
    "Modules (by directory, with their files):",
    ...mods.map((m) => `[${m.i}] ${m.module || "(repo root)"} — ${m.files.slice(0, FILE_CAP).join(", ")}${m.files.length > FILE_CAP ? ", …" : ""}`),
    "",
    'Output ONLY a JSON array, ONE object per module: [{"id":"<index>","label":"<concern|none>"}, …]',
  ].join("\n");
}

// Load the cached labels and, for any module whose file-list hash changed (or is new), LEARN its label via one
// batched LLM call — then persist. Returns moduleKey → concern (real concerns only). Memoised per repo/process.
export async function loadOrBuildConcernMap(repo: string, opts: { model?: string; claudeBin?: string | null }, ctx?: EngineCtx): Promise<ConcernMap> {
  const memo = _mem.get(repo);
  if (memo) return memo;
  const modules = _modules(repo);
  const cached = _loadDisk(repo);
  const persist = new Map<string, DiskEntry>();
  const result: ConcernMap = new Map();
  const toLearn: { i: number; module: string; files: string[]; hash: string }[] = [];
  for (const [mod, files] of modules) {
    const hash = _hash(files.join("|"));
    const c = cached.get(mod);
    if (c && c.hash === hash) { persist.set(mod, c); if (isConcernLabel(c.label)) result.set(mod, c.label); continue; }
    toLearn.push({ i: toLearn.length, module: mod, files, hash });
  }
  // LEARN the uncached/drifted modules — never in the throwaway stable-floor probe (I5), never offline (I3).
  if (toLearn.length && !ctx?.stableFloor && llmAvailable(opts.claudeBin)) {
    try {
      const out = await run_pass_async(_prompt(toLearn), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag });
      for (const t of toLearn) {
        const v = out.get(String(t.i));
        const raw = v && typeof v.label === "string" ? v.label : "none";
        const label = CONCERN_LABELS.has(raw) ? raw : "none";   // grounding: an out-of-vocab label → none
        persist.set(t.module, { label, hash: t.hash });
        if (isConcernLabel(label)) result.set(t.module, label);
      }
      _writeDisk(repo, persist);
    } catch { /* LLM failed → keep only the cached labels (degrade), do not persist partial */ }
  }
  _mem.set(repo, result);
  return result;
}

// The concern label of a node's module (a real concern), or null (`none` / unlabelled / no file).
export function concernOf(map: ConcernMap, repo: string, file: string | undefined): string | null {
  if (!file) return null;
  const label = map.get(moduleKey(repo, file));
  return label && isConcernLabel(label) ? label : null;
}
