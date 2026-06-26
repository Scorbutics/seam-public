// RECEIVER CLASSIFICATION — the type-adapter ladder. Instead of the flywheel learning a rule per receiver
// ("adapter bloat"), INVENTORY the codebase's recurring receivers + verb profiles, CLASSIFY each into a type,
// and synthesise a deterministic adapter for the type. Phase 1 acts on `database` → `repository` matchers for
// a 2-part data layer (`users.create()`, `featuresRepository.set…()`) that member_access (3-part) can't see.
//
// The ladder, cheapest-first (per the design doc):
//   1. IDIOM (deterministic) narrows to CANDIDATES — a receiver that both reads and writes data-shaped verbs.
//   2. LLM CONFIRMS each candidate's type. This rung is LOAD-BEARING for the 2-part shape: it has no 3-part
//      guard, so `axios.delete()`/`axios.create()` look identical to a repo — only the LLM (the dev's head)
//      separates axios-the-http-client from userRepository-the-data-layer. Cheap: one batched call over the
//      candidates, persisted (learn-once → deterministic warm), gated by the candidate-set signature.
// Grounding (co-occurrence) remains the backstop. (Embeddings — the cheap middle rung — would pre-filter the
// candidates, but coupling/ is the DAG leaf so they must arrive via a threaded ctx callback; deferred.)
import { createHash } from "node:crypto";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { run_pass, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit, verbose } from "../../core/progress.js";
import { makeMaskCtx } from "./adapters/util.js";
import { scannableForKeys } from "./adapters/index.js";
import { ORM_READ_VERBS, ORM_WRITE_VERBS } from "./adapters/member_access.js";
import { DB_TABLE_META } from "./adapters/db_table.js";
import { validateMatcher, type KeyMatcher } from "./key_ir.js";
import { persistMatchers, hasLearnedMatchersFor, recordLearnedMatchers } from "./key_store.js";
import { EngineCtx } from "../engine_ctx.js";

const PASS = registerPass({ tag: "classify-receivers", tier: "strong", note: "receiver→type classification (database/http/store/…); learn-once → .seam" });

const SELF = new Set(["this", "self", "super"]);
const CHAIN = /(?<![\w$.])((?:[A-Za-z_$][\w$]*\s*\.\s*)+[A-Za-z_$][\w$]*)\s*\(/g;
const MIN_FILES = 4;          // a receiver must recur across files to be a shared abstraction (not a local)
const MAX_CANDIDATES = 80;    // bound the LLM prompt to the most-recurring candidates
const _ORM_R = new Set<string>(ORM_READ_VERBS), _ORM_W = new Set<string>(ORM_WRITE_VERBS);

// read/write by NAMING CONVENTION (camelCase method prefix) — robust for custom verbs (deleteByEmail → write,
// checkIfEnabled → read). Structural, not a meaning-guess; an ambiguous verb just doesn't split.
const _READ_PRE = ["get", "find", "fetch", "load", "list", "read", "query", "count", "exists", "check", "is", "has", "select", "retrieve", "search", "lookup"];
const _WRITE_PRE = ["set", "create", "insert", "add", "save", "update", "delete", "remove", "destroy", "upsert", "put", "patch", "write", "store", "persist"];
const _reads = (vs: string[]) => vs.filter((v) => _ORM_R.has(v) || _READ_PRE.some((p) => v.toLowerCase().startsWith(p)));
const _writes = (vs: string[]) => vs.filter((v) => _ORM_W.has(v) || _WRITE_PRE.some((p) => v.toLowerCase().startsWith(p)));

interface Profile { receiver: string; verbs: Map<string, number>; files: number }

function _inventory(repo: string, skipDirs: Set<string>): Profile[] {
  const inv = new Map<string, { files: Set<string>; verbs: Map<string, number> }>();
  for (const { rel, text } of walkFiles(repo, skipDirs, scannableForKeys)) {
    const code = makeMaskCtx(text).comments; let m: RegExpExecArray | null; CHAIN.lastIndex = 0;
    while ((m = CHAIN.exec(code)) !== null) {
      let p = m[1].split(".").map((s) => s.trim()).filter(Boolean);
      while (p.length && SELF.has(p[0])) p.shift();
      if (p.length < 2) continue;
      const root = p[0], verb = p[p.length - 1];
      if (root.length < 2) continue;
      let e = inv.get(root); if (!e) { e = { files: new Set(), verbs: new Map() }; inv.set(root, e); }
      e.files.add(rel); e.verbs.set(verb, (e.verbs.get(verb) ?? 0) + 1);
    }
  }
  return [...inv].filter(([, e]) => e.files.size >= MIN_FILES).map(([receiver, e]) => ({ receiver, verbs: e.verbs, files: e.files.size }));
}

// a CANDIDATE both reads AND writes data-shaped verbs (a data layer) — the broad net the LLM then confirms.
function _candidates(profs: Profile[]): Profile[] {
  return profs.filter((p) => { const vs = [...p.verbs.keys()]; return _reads(vs).length > 0 && _writes(vs).length > 0; })
    .sort((a, b) => b.files - a.files).slice(0, MAX_CANDIDATES);
}

const _profileLine = (p: Profile) => `${p.receiver}: ${[...p.verbs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, c]) => `${v}(${c})`).join(" ")}`;

function _prompt(cands: Profile[]): string {
  return `You are classifying RECEIVER OBJECTS in a codebase by WHAT KIND of resource each one accesses —
judging only from the methods called on it (a dev recognises "userRepository is the user data layer", "axios
is the http client"). For each receiver below you get its name and the methods called on it (with counts).

Classify each as exactly one of:
  database — a DB / ORM / repository data layer (entities read & written: create/findMany/update/delete/save)
  http     — an HTTP client or request/response object (get/post/put/delete a URL, fetch, status, json, redirect)
  config   — configuration access (get/set of settings, flags, environment)
  store    — in-memory / client state, cache, or session store (get/set/dispatch of state, not persisted records)
  event    — an event / message bus (emit/publish/subscribe/listen)
  none     — none of the above: logging, test mocks/assertions, stdlib, local collections, generic utilities

Judge by MEANING, not just verb names — \`axios.create\`/\`axios.delete\` are HTTP (a client + an HTTP DELETE),
NOT database; \`session.get\`/\`set\` is a store, not a database; a \`*Repository\`/\`*Fixture\` of entities is database.

${cands.map(_profileLine).join("\n")}

Return a JSON array, one object per receiver — "id" is the receiver NAME exactly as given:
[{"id":"userRepository","type":"database"},{"id":"axios","type":"http"}]`;
}

function _parse(out: Map<string, any>): Map<string, string> {
  const types = new Map<string, string>();
  for (const obj of out.values()) {
    if (!obj || typeof obj !== "object") continue;
    const r = String(obj.id ?? obj.receiver ?? "").trim(), t = String(obj.type ?? "").trim().toLowerCase();
    if (r && t) types.set(r, t);
  }
  return types;
}

// Classify the recurring receivers (LLM) and PERSIST `repository` matchers for the database ones. Idempotent
// per run (ctx cache) and per repo (the candidate-set signature gates the LLM, so a warm `.seam` replays the
// persisted matchers with no call). No-op without opts.llm/backend → degrades to member_access (3-part) only.
export async function classifyAndPersistRepositories(
  repo: string, opts: { llm?: boolean; model?: string; claudeBin?: string | null }, ctx: EngineCtx,
): Promise<KeyMatcher[]> {
  if (ctx.repoMatchers.has(repo)) return ctx.repoMatchers.get(repo) as KeyMatcher[];
  if (!opts.llm) { ctx.repoMatchers.set(repo, []); return []; }
  const cands = _candidates(_inventory(repo, SKIP_DIRS));
  if (!cands.length) { ctx.repoMatchers.set(repo, []); return []; }

  // gate the LLM on the candidate SET (names + profiles): a re-run with the same receivers replays — no call
  const sig = "rc:" + createHash("sha1").update(cands.map(_profileLine).sort().join("\n")).digest("hex");
  if (hasLearnedMatchersFor(repo, sig)) { ctx.repoMatchers.set(repo, []); return []; }   // persisted already; loadMatchers has them

  emit(`Classifying ${cands.length} recurring receiver(s) by type (database/http/store/…) via LLM…`);
  let types = new Map<string, string>();
  try { types = _parse(run_pass(_prompt(cands), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag })); }
  catch (e) { if (!(e instanceof LLMError)) throw e; ctx.repoMatchers.set(repo, []); return []; }

  const matchers: KeyMatcher[] = [];
  for (const p of cands) {
    if (types.get(p.receiver) !== "database") continue;   // the LLM confirms — drops axios/session/external
    const reads = _reads([...p.verbs.keys()]), writes = _writes([...p.verbs.keys()]);
    const r = validateMatcher({ via: "repository", token: p.receiver, verbs: reads, kind: DB_TABLE_META.kind, role: "consumes" });
    const w = validateMatcher({ via: "repository", token: p.receiver, verbs: writes, kind: DB_TABLE_META.kind, role: "produces" });
    if (r) matchers.push(r);
    if (w) matchers.push(w);
  }
  if (verbose()) process.stderr.write(`[receiver-class] ${cands.length} candidate(s) → ${[...new Set(matchers.map((m: any) => m.token))].length} database receiver(s): ${[...new Set(matchers.map((m: any) => m.token))].join(", ")}\n`);
  persistMatchers(repo, matchers);          // join the matcher store → loadMatchers/applyMatchers ground them
  recordLearnedMatchers(repo, sig);         // gate: same candidates next run → replay, no LLM
  ctx.repoMatchers.set(repo, matchers);
  return matchers;
}
