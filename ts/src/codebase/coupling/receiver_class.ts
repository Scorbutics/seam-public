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
import { run_pass_async, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit, verbose } from "../../core/progress.js";
import { makeMaskCtx } from "./adapters/util.js";
import { scannableForKeys } from "./adapters/index.js";
import { ORM_READ_VERBS, ORM_WRITE_VERBS } from "./adapters/member_access.js";
import { DB_TABLE_META } from "./adapters/db_table.js";
import { validateMatcher, type KeyMatcher } from "./key_ir.js";
import { persistMatchers, hasLearnedMatchersFor, recordLearnedMatchers } from "./key_store.js";
import { _ROUTE_ANNOT as _BUILTIN_ROUTE_ANNOT } from "./adapters/annotation_route.js";
import { EngineCtx } from "../engine_ctx.js";

const PASS = registerPass({ tag: "classify-receivers", tier: "strong", note: "receiver→type classification (database/http/store/…); learn-once → .seam" });
const ANNOT_PASS = registerPass({ tag: "classify-annotations", tier: "strong", note: "annotation→type (route/queue/event) — custom route/listener annotations a hardcoded set misses; learn-once → .seam" });

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
// EVENT verbs are matched EXACTLY (not by prefix — `on`/`handle` as prefixes would catch onClick/handler):
// producer side (emit) vs consumer side (listen). `store` reuses the read/write conventions (get/set).
const _EVENT_P = new Set(["emit", "publish", "dispatch", "fire", "trigger", "broadcast", "next", "send"]);
const _EVENT_C = new Set(["on", "once", "subscribe", "listen", "addeventlistener", "addlistener", "handle"]);
// HTTP CLIENT verbs — a `<client>.<verb>('/route')` call; all CONSUME the endpoint (the route literal is the
// key, kind http-route → grounds with the backend handler that PRODUCES it). `post`/`request` also count as
// a produce-ish verb for CANDIDACY (so a pure get/post client qualifies as both-sided).
const _HTTP_CLIENT = new Set(["get", "post", "put", "delete", "patch", "request", "fetch", "head", "options"]);
const _HTTP_W = new Set(["post", "put", "patch", "request"]);
const _lc = (v: string) => v.toLowerCase();
const _isProd = (v: string) => _writes([v]).length > 0 || _EVENT_P.has(_lc(v)) || _HTTP_W.has(_lc(v));
const _isCons = (v: string) => _reads([v]).length > 0 || _EVENT_C.has(_lc(v));

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

// a CANDIDATE both PRODUCES and CONSUMES (a data layer / channel that's written AND read) — the broad net the
// LLM then confirms + types (database / event / store / …). emit⇄on and set⇄get both qualify.
function _candidates(profs: Profile[]): Profile[] {
  return profs.filter((p) => { const vs = [...p.verbs.keys()]; return vs.some(_isProd) && vs.some(_isCons); })
    .sort((a, b) => b.files - a.files).slice(0, MAX_CANDIDATES);
}

const _profileLine = (p: Profile) => `${p.receiver}: ${[...p.verbs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, c]) => `${v}(${c})`).join(" ")}`;

function _prompt(cands: Profile[]): string {
  return `You are classifying RECEIVER OBJECTS in a codebase by WHAT KIND of resource each one accesses —
judging only from the methods called on it (a dev recognises "userRepository is the user data layer", "axios
is the http client"). For each receiver below you get its name and the methods called on it (with counts).

Classify each as exactly one of:
  database — a DB / ORM / repository data layer (entities read & written: create/findMany/update/delete/save)
  http     — an HTTP CLIENT that CALLS a remote endpoint BY ROUTE PATH (\`axios.get('/api/x')\`, fetch, a custom
             \`$http.post('/url')\`). The string arg is a route. NOT a request/response/url/params object that
             reads headers/params/body LOCALLY (\`req.get('header')\`, \`res.json()\`, \`params.get('id')\`,
             \`searchParams.get\`, \`url.get\`) — those carry no cross-service route, classify them \`none\`.
  config   — configuration access (get/set of settings, flags, environment)
  store    — in-memory / client state, cache, or session store (get/set/dispatch of state, not persisted records)
  event    — an event / message bus (emit/publish/subscribe/listen)
  none     — none of the above: logging, test mocks/assertions, stdlib, local collections, request/response/url
             objects, generic utilities

Judge by MEANING, not just verb names — \`axios.create\`/\`axios.delete\` are HTTP (a client + an HTTP DELETE),
NOT database; \`session.get\`/\`set\` is a store, not a database; a \`*Repository\`/\`*Fixture\` of entities is
database; \`req\`/\`res\`/\`params\`/\`searchParams\`/\`url\` are \`none\` (they read local request data, not a route).

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
  try { types = _parse(await run_pass_async(_prompt(cands), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag })); }
  catch (e) { if (!(e instanceof LLMError)) throw e; ctx.repoMatchers.set(repo, []); return []; }

  const matchers: KeyMatcher[] = [];
  const push = (m: KeyMatcher | null) => { if (m) matchers.push(m); };
  for (const p of cands) {
    const t = types.get(p.receiver);                      // the LLM confirms the type — drops axios/session/none
    const vs = [...p.verbs.keys()];
    if (t === "database") {
      // 2-part repository: the RECEIVER is the table (member_access covers the 3-part case)
      push(validateMatcher({ via: "repository", token: p.receiver, verbs: _reads(vs), kind: DB_TABLE_META.kind, role: "consumes" }));
      push(validateMatcher({ via: "repository", token: p.receiver, verbs: _writes(vs), kind: DB_TABLE_META.kind, role: "produces" }));
    } else if (t === "event" || t === "store") {
      // receiver-scoped channel: the STRING-LITERAL arg is the key (bus.emit('e') ⇄ bus.on('e'))
      const kind = t === "event" ? "event" : "cache";
      const prod = vs.filter(_isProd), cons = vs.filter(_isCons);
      if (prod.length) push(validateMatcher({ via: "channel", token: p.receiver, verbs: prod, kind, role: "produces" }));
      if (cons.length) push(validateMatcher({ via: "channel", token: p.receiver, verbs: cons, kind, role: "consumes" }));
    } else if (t === "http") {
      // an http CLIENT consumes a route — `client.get('/route')`; the route literal grounds with the backend
      // handler that PRODUCES it (annotation-route / next-route). The cross-stack hop, framework-agnostic
      // (any client name). A RESPONSE receiver (res/json/status — no client verbs) yields no rule here.
      const httpVerbs = vs.filter((v) => _HTTP_CLIENT.has(_lc(v)));
      if (httpVerbs.length) push(validateMatcher({ via: "channel", token: p.receiver, verbs: httpVerbs, kind: "http-route", role: "consumes" }));
    }
  }
  if (verbose()) { const by = (t: string) => cands.filter((c) => types.get(c.receiver) === t).map((c) => c.receiver); process.stderr.write(`[receiver-class] ${cands.length} candidate(s) → db: ${by("database").join(", ")} | event: ${by("event").join(", ")} | store: ${by("store").join(", ")}\n`); }
  persistMatchers(repo, matchers);          // join the matcher store → loadMatchers/applyMatchers ground them
  recordLearnedMatchers(repo, sig);         // gate: same candidates next run → replay, no LLM
  ctx.repoMatchers.set(repo, matchers);
  return matchers;
}

// ── ANNOTATION CLASSIFICATION ────────────────────────────────────────────────────────────────────────
// The same ladder for ANNOTATIONS: a `@Name("literal")` decorator is to a route/queue/event what a receiver
// is to a data layer — a recurring named pattern carrying a key, that structure surfaces and the LLM judges.
// The builtin route-annotation set (annotation_route._ROUTE_ANNOT) is the floor IDIOM; this learns a project's
// CUSTOM ones. Many annotations share the `@Name("lit")` shape (route vs @Param/@DocsTags/@Roles) — the
// discriminator is MEANING (a path vs a field name vs a doc tag), so the LLM is needed (validated: 100% on
// cal.com). Emits `annotation` matchers (kind http-route/queue/event) applied via applyMatchers — no floor
// integration. NOTE: this handles SINGLE-annotation custom routes; a custom class+method COMPOSITION still
// relies on the builtin set (the floor `scan` is sync/repo-less, can't read learned state — deferred).
const _ANNOT_RE = /@(\w+)\s*\(\s*["'`]([^"'`\s][^"'`]*)["'`]/g;
interface AnnotProfile { name: string; lits: Set<string>; files: number }

function _annotInventory(repo: string, skipDirs: Set<string>): AnnotProfile[] {
  const inv = new Map<string, { files: Set<string>; lits: Set<string> }>();
  for (const { rel, text } of walkFiles(repo, skipDirs, scannableForKeys)) {
    const code = makeMaskCtx(text).comments; let m: RegExpExecArray | null; _ANNOT_RE.lastIndex = 0;
    while ((m = _ANNOT_RE.exec(code)) !== null) {
      let e = inv.get(m[1]); if (!e) { e = { files: new Set(), lits: new Set() }; inv.set(m[1], e); }
      e.files.add(rel); e.lits.add(m[2]);
    }
  }
  return [...inv].filter(([, e]) => e.files.size >= MIN_FILES).map(([name, e]) => ({ name, lits: e.lits, files: e.files.size }))
    .sort((a, b) => b.files - a.files).slice(0, MAX_CANDIDATES);
}

function _annotPrompt(cands: AnnotProfile[]): string {
  const lines = cands.map((c) => `@${c.name}: ${[...c.lits].slice(0, 6).map((l) => `"${l.slice(0, 28)}"`).join(" ")}`).join("\n");
  return `Classify each ANNOTATION/decorator by what KIND of cross-service coupling its STRING-LITERAL arg
declares — judging by MEANING, not the name. Is the literal a URL ROUTE PATH, a message QUEUE/topic, an EVENT
name — or NONE of those (a param/header name, a doc tag, a role/enum, a config flag, a bean name)?
  route — the literal is a URL path: "/", "/:id", "v1", "member/booking" (an HTTP endpoint the handler serves)
  queue — a message queue / topic name (JMS/Kafka/AMQP listener: @JmsListener("orders.export"))
  event — an application event name (@EventListener("user.created"), @OnEvent("order.placed"))
  none  — a param/header NAME ("userId","Authorization"), a doc tag ("Bookings"), a role/enum ("TEAM_ADMIN",
          "SCALE"), a config flag, a bean/DI name — NOT a cross-service key.

${lines}

Return a JSON array, id = the annotation name (no @): [{"id":"Get","type":"route"},{"id":"Param","type":"none"}]`;
}

// Classify recurring annotations (LLM) and PERSIST `annotation` matchers for the route/queue/event ones.
// Mirrors classifyAndPersistRepositories: idempotent per run + gated per candidate-set signature.
export async function classifyAndPersistAnnotations(
  repo: string, opts: { llm?: boolean; model?: string; claudeBin?: string | null }, ctx: EngineCtx,
): Promise<KeyMatcher[]> {
  if (ctx.annotMatchers.has(repo)) return ctx.annotMatchers.get(repo) as KeyMatcher[];
  if (!opts.llm) { ctx.annotMatchers.set(repo, []); return []; }
  const cands = _annotInventory(repo, SKIP_DIRS);
  if (!cands.length) { ctx.annotMatchers.set(repo, []); return []; }
  const sig = "ra:" + createHash("sha1").update(cands.map((c) => `${c.name}:${[...c.lits].sort().join(",")}`).sort().join("\n")).digest("hex");
  if (hasLearnedMatchersFor(repo, sig)) { ctx.annotMatchers.set(repo, []); return []; }

  emit(`Classifying ${cands.length} recurring annotation(s) by type (route/queue/event) via LLM…`);
  let types = new Map<string, string>();
  try { types = _parse(await run_pass_async(_annotPrompt(cands), { model: opts.model, claudeBin: opts.claudeBin, tag: ANNOT_PASS.tag })); }
  catch (e) { if (!(e instanceof LLMError)) throw e; ctx.annotMatchers.set(repo, []); return []; }

  const matchers: KeyMatcher[] = [];
  const push = (m: KeyMatcher | null) => { if (m) matchers.push(m); };
  for (const c of cands) {
    const t = types.get(c.name);
    if (t === "route" && !_BUILTIN_ROUTE_ANNOT.has(c.name)) push(validateMatcher({ via: "annotation", annotation: c.name, kind: "http-route", role: "produces" }));   // CUSTOM route annot only — the floor already handles @Get/@Path
    else if (t === "queue") push(validateMatcher({ via: "annotation", annotation: c.name, kind: "queue", role: "consumes" }));        // a listener consumes the queue
    else if (t === "event") push(validateMatcher({ via: "annotation", annotation: c.name, kind: "event", role: "consumes" }));        // a handler consumes the event
  }
  if (verbose()) { const by = (t: string) => cands.filter((c) => types.get(c.name) === t).map((c) => "@" + c.name); process.stderr.write(`[annot-class] route: ${by("route").join(", ")} | queue: ${by("queue").join(", ")} | event: ${by("event").join(", ")}\n`); }
  persistMatchers(repo, matchers);
  recordLearnedMatchers(repo, sig);
  ctx.annotMatchers.set(repo, matchers);
  return matchers;
}
