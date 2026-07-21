// SCAN phase — the repo-wide INTERFACE→IMPL (DI binding) index and the framework-entry detector. This is
// the runtime wiring a static import scan can't see: which concrete classes implement an interface
// (@Inject/@Autowired/CDI), and whether a symbol is a declaratively-wired framework callback. Cross-
// language via ../atoms node SETS. Cached per repo (a full-repo parse, built once).
import { join, relative } from "node:path";
import { endsWithSourceExt, SKIP_DIRS, impl_markers } from "../../../core/resolve/languages/index.js";
import { walk } from "../../../core/resolve/walk.js";
import { recordQuery, registerQueryRerun, hashSet } from "../../../core/resolve/dep_recorder.js";
import {
  makeCtx, available, lang_for,
  _CLASS_KINDS, _METHOD_KINDS, _INTERFACE, _IMPLEMENTS, _BASE_NAME, _HERITAGE, _ANNOTATION,
} from "../../atoms.js";
import { _name_of, _read } from "../ast_units.js";
import { incrementalScanAsync, indexCacheEnabled } from "../../coupling/index_cache.js";

// {interface name → the concrete in-repo CLASSES that `implement` it} + the set of names declared as
// interfaces. Cross-language via _IMPLEMENTS (Java super_interfaces / TS implements_clause). Cached per
// repo (a full-repo parse, so built once). This is the runtime DI binding a static import scan can't
// see — used to extend a footprint PAST a @Inject/@Autowired interface to its impl, deterministically.
// Per-FILE contribution (the map half): the interface names this file declares + the (super → class) impl
// edges it introduces. JSON-serializable so incrementalScanAsync persists it to `.seam/impl-index.json`
// keyed by file identity — a one-file edit re-parses only that file, the merge (reduce) recombines.
// edges: [implementedInterface, class]; accessors: [methodName, returnTypeName] for ZERO-ARG methods (the DI
// provider-factory shape `GroupProvider groups()`), kept only when the return type is a real interface at merge.
type ImplContribution = { interfaces: string[]; edges: [string, string][]; accessors: [string, string][] };

// The BASE name of a type node's text — strip a generic arg list and a package qualifier, so
// `org.keycloak.models.GroupProvider` / `List<Group>` reduce to `GroupProvider` / `List`.
function _baseTypeName(t: string): string {
  const noGen = t.replace(/<.*$/s, "").trim();
  const seg = noGen.split(".").pop() ?? noGen;
  return /^[A-Za-z_$][\w$]*$/.test(seg) ? seg : "";
}

// Parse ONE file → its interface declarations + impl edges. The async unit incrementalScanAsync caches.
async function _scanImplFile(rel: string, text: string): Promise<ImplContribution> {
  // PARSE PRE-GATE (registry-sourced): skip the expensive tree-sitter parse for files that cannot declare an
  // interface or implements-clause in their language — `[]` markers (Python/Ruby: no such concept) skip ALL;
  // Java/TS skip unless the keyword is textually present. Sound: the node kinds require the keyword. Cuts the
  // COLD first-run parse set (the persisted index then makes re-runs O(changed) regardless).
  const markers = impl_markers(rel);
  if (markers !== undefined && !markers.some((m) => text.includes(m))) return { interfaces: [], edges: [], accessors: [] };
  const grammar = lang_for(rel);
  if (!grammar) return { interfaces: [], edges: [], accessors: [] };
  const ctx = await makeCtx(text, grammar);
  if (!ctx) return { interfaces: [], edges: [], accessors: [] };
  const interfaces: string[] = [];
  const edges: [string, string][] = [];
  for (const itf of ctx.collect(ctx.root, (k) => _INTERFACE.has(k))) {
    const nm = _name_of(ctx, itf);
    if (!nm) continue;
    interfaces.push(nm);
    // INTERFACE-EXTENDS-INTERFACE — a sub-interface's impls ARE impls of its super-interface (Java `UserModel extends
    // RoleMapperModel` → a UserModel impl like UserAdapter also implements RoleMapperModel). Record [super, sub] (same
    // shape as [interface, class]) so the closure in _impl_index propagates concrete classes UP the interface chain.
    // Without it, a call on a SUPER-interface (`roleMapper.grantRole` on RoleMapperModel) resolves to NO impl and the
    // DI hop is lost — the flow then latches onto an unrelated coupling write. _HERITAGE covers Java `extends_interfaces`
    // + TS interface `extends_clause`; _BASE_NAME reads the super names (same extraction as the class-implements edge).
    for (const h of ctx.children(itf)) if (_HERITAGE.has(h.type))
      for (const sn of ctx.collect(h, (k) => _BASE_NAME.has(k)).map((n) => ctx.text(n))) if (sn && sn !== nm) edges.push([sn, nm]);
  }
  for (const cls of ctx.collect(ctx.root, (k) => _CLASS_KINDS.has(k))) {
    const cn = _name_of(ctx, cls);
    if (!cn) continue;
    const supers: string[] = [];
    for (const h of ctx.children(cls)) {
      if (_IMPLEMENTS.has(h.type)) supers.push(...ctx.collect(h, (k) => _BASE_NAME.has(k)).map((n) => ctx.text(n)));
      else if (h.type === "class_heritage") for (const ec of ctx.children(h).filter((c) => _IMPLEMENTS.has(c.type))) supers.push(...ctx.collect(ec, (k) => _BASE_NAME.has(k)).map((n) => ctx.text(n)));
    }
    for (const s of supers) edges.push([s, cn]);
  }
  // PROVIDER-ACCESSOR shape — a ZERO-ARG method whose return type is a type name (`GroupProvider groups()`,
  // `UserProvider users()`). These are the DI factory accessors a chained `session.groups().createGroup()` hops
  // through; kept only when the return type resolves to a real interface at merge (so it fans to impls, not noise).
  const accessors: [string, string][] = [];
  for (const m of ctx.collect(ctx.root, (k) => _METHOD_KINDS.has(k))) {
    const nm = _name_of(ctx, m);
    if (!nm) continue;
    const params = (m as any).childForFieldName?.("parameters");
    if (params && ctx.children(params).some((c) => /parameter/.test(c.type))) continue;   // ZERO-arg only
    const rt = (m as any).childForFieldName?.("type");   // the declared return type (Java/TS field `type`)
    if (!rt) continue;
    const tn = _baseTypeName(ctx.text(rt));
    if (tn && tn !== nm) accessors.push([nm, tn]);
  }
  return { interfaces, edges, accessors };
}

type ImplIndex = { interfaces: Set<string>; impls: Map<string, { cls: string; file: string }[]>; accessors: Map<string, Set<string>> };
const _IMPL_CACHE = new Map<string, ImplIndex>();
// Clear the per-process memo (the disk cache in `.seam/impl-index.json` stays — it self-invalidates per file
// by mtime/size). For tests, and any caller that needs a fresh in-process read after files changed mid-run.
export function _resetImplIndexMem(): void { _IMPL_CACHE.clear(); }
async function _impl_index(repo: string): Promise<ImplIndex> {
  const cached = _IMPL_CACHE.get(repo);   // per-process memo (one build/run, even with the disk cache below)
  if (cached) return cached;
  const interfaces = new Set<string>();
  const impls = new Map<string, { cls: string; file: string }[]>();
  const rawAccessors: [string, string][] = [];   // (methodName, returnType) — filtered to real interfaces below
  const addEdge = (sup: string, cls: string, file: string) => {
    const arr = impls.get(sup) ?? [];
    if (!arr.some((x) => x.cls === cls && x.file === file)) arr.push({ cls, file });
    impls.set(sup, arr);
  };
  // The full-repo PARSE (the cold large-repo cost). incrementalScanAsync persists each file's contribution to
  // `.seam/impl-index.json` keyed by (mtime,size) → a re-run re-parses only CHANGED files, not all 4000+.
  if (indexCacheEnabled()) {
    for (const { rel, data } of await incrementalScanAsync(repo, SKIP_DIRS, endsWithSourceExt, "impl-v3", _scanImplFile, "impl-index")) {
      for (const itf of data.interfaces) interfaces.add(itf);
      for (const [sup, cls] of data.edges) addEdge(sup, cls, rel);
      for (const a of data.accessors ?? []) rawAccessors.push(a);
    }
  } else {   // SEAM_INDEX_CACHE=0 → the plain, byte-identical full walk (no persistence)
    for (const [dir, files] of walk(repo, SKIP_DIRS)) for (const fn of files) {
      if (!endsWithSourceExt(fn)) continue;
      const rel = relative(repo, join(dir, fn)).replace(/\\/g, "/");
      const rd = _read(repo, rel);
      if (!rd) continue;
      const data = await _scanImplFile(rel, rd[0]);
      for (const itf of data.interfaces) interfaces.add(itf);
      for (const [sup, cls] of data.edges) addEdge(sup, cls, rel);
      for (const a of data.accessors) rawAccessors.push(a);
    }
  }
  // TRANSITIVE CLOSURE over interface-extends — an impl entry whose `cls` is itself an INTERFACE (a [super, sub]
  // interface-extends edge) is expanded to that sub-interface's CONCRETE impls, so resolving a SUPER-interface
  // (RoleMapperModel) reaches the concrete class (UserAdapter) that implements it via a sub-interface (UserModel).
  // Direct concrete impls are kept as-is; cycles are guarded by `seen`. Computed once at build (cached with the index).
  const resolveConcrete = (name: string, seen: Set<string>): { cls: string; file: string }[] => {
    const out: { cls: string; file: string }[] = [];
    for (const e of impls.get(name) ?? []) {
      if (interfaces.has(e.cls)) { if (!seen.has(e.cls)) { seen.add(e.cls); out.push(...resolveConcrete(e.cls, seen)); } }
      else out.push(e);   // a concrete class implementing `name` (directly or via a sub-interface)
    }
    return out;
  };
  const closed = new Map<string, { cls: string; file: string }[]>();
  for (const name of impls.keys()) {
    const uniq: { cls: string; file: string }[] = [];
    for (const e of resolveConcrete(name, new Set([name]))) if (!uniq.some((x) => x.cls === e.cls && x.file === e.file)) uniq.push(e);
    closed.set(name, uniq);
  }
  impls.clear();
  for (const [k, v] of closed) if (v.length) impls.set(k, v);
  // KEEP an accessor only when its return type is a real interface WITH impls — a grounded factory hop, never a
  // name guess. `methodName → the interface(s) it returns` (usually one; a Set handles a rare same-name collision).
  const accessors = new Map<string, Set<string>>();
  for (const [m, ret] of rawAccessors) {
    if (!interfaces.has(ret) || !(impls.get(ret)?.length)) continue;
    (accessors.get(m) ?? accessors.set(m, new Set()).get(m)!).add(ret);
  }
  const idx = { interfaces, impls, accessors };
  _IMPL_CACHE.set(repo, idx);
  return idx;
}

// The concrete in-repo implementations of an INTERFACE `name` (deterministic, sorted). Empty unless
// `name` is declared as an interface in this repo — so we never chase a concrete class's subclasses,
// only the genuine interface→impl (DI) relation.
export async function impls_of(repo: string, name: string): Promise<{ cls: string; file: string }[]> {
  const idx = await _impl_index(repo);
  if (!idx.interfaces.has(name)) { recordQuery("impls", [name], []); return []; }
  const out = [...(idx.impls.get(name) ?? [])].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  recordQuery("impls", [name], out.map(_implKey));   // open-set: a NEW impl of the interface invalidates
  return out;
}
const _implKey = (i: { cls: string; file: string }) => `${i.cls}|${i.file}`;
registerQueryRerun("impls", async (repo, [name]) => hashSet((await impls_of(repo, name)).map(_implKey)));

// DI PROVIDER-FACTORY resolution (the `session.groups().createGroup()` hop). `methodName → the interface(s) it
// returns` — but ONLY for zero-arg accessors whose return type is a real in-repo interface WITH impls, so a hop
// is a grounded fact (declared return type + impl registry), never a name guess. Empty map ⇒ feature is a no-op.
export async function provider_accessors(repo: string): Promise<Map<string, Set<string>>> {
  const acc = (await _impl_index(repo)).accessors;
  recordQuery("provider-accessors", [], _accessorKeys(acc));
  return acc;
}
const _accessorKeys = (acc: Map<string, Set<string>>) =>
  [...acc].map(([m, ifs]) => `${m}:${[...ifs].sort().join(",")}`);
registerQueryRerun("provider-accessors", async (repo) => hashSet(_accessorKeys(await provider_accessors(repo))));

// `name` is an in-repo interface that HAS impls — the grounding gate for the `getProvider(X.class)` /
// `getInstance(X.class)` service-locator form (the argument X is the interface to resolve).
export async function is_provider_interface(repo: string, name: string): Promise<boolean> {
  const idx = await _impl_index(repo);
  const r = idx.interfaces.has(name) && !!idx.impls.get(name)?.length;
  recordQuery("is-provider", [name], [String(r)]);
  return r;
}
registerQueryRerun("is-provider", async (repo, [name]) => hashSet([String(await is_provider_interface(repo, name))]));

// The interface names a class `symbol` (in `anchorFile`) IMPLEMENTS. Used to reach the facade-style
// upstream entries a bidirectional grow misses: DI/CDI consumers import the INTERFACE, not the impl, so
// growing consumers of the impl finds nothing — growing consumers of its interfaces does (deterministic).
export async function implemented_interfaces(repo: string, anchorFile: string, symbol: string): Promise<string[]> {
  const rd = _read(repo, anchorFile);
  if (!rd || !available()) return [];
  const ctx = await makeCtx(rd[0], rd[1]);
  if (!ctx) return [];
  const cls = ctx.collect(ctx.root, (k) => _CLASS_KINDS.has(k)).find((c) => _name_of(ctx, c) === symbol);
  if (!cls) return [];
  const out: string[] = [];
  for (const h of ctx.children(cls)) {
    if (_IMPLEMENTS.has(h.type)) out.push(...ctx.collect(h, (k) => _BASE_NAME.has(k)).map((n) => ctx.text(n)));
    else if (h.type === "class_heritage") for (const ec of ctx.children(h).filter((c) => _IMPLEMENTS.has(c.type))) out.push(...ctx.collect(ec, (k) => _BASE_NAME.has(k)).map((n) => ctx.text(n)));
  }
  return [...new Set(out)];
}

// FRAMEWORK-ENTRY detection — generalized, NO per-framework annotation list. A `symbol` (method or
// class) is a framework/external entry when it's wired declaratively: (a) it carries a METHOD-LEVEL
// annotation/decorator (any — `@GET`/`@Schedule`/`@PostConstruct`/`@Observes`/a TS `@Get()`…; presence
// is the signal, not the name), or (b) its enclosing class implements an EXTERNAL interface (one not
// declared in this repo, e.g. `MessageListener` → `onMessage` is the framework callback). Combined by
// the caller with "no in-repo caller", this distinguishes a framework ROOT (flow enters here from
// outside the repo) from genuinely-isolated/dead code — across any annotation/decorator framework.
export async function is_framework_entry(repo: string, file: string, symbol: string): Promise<boolean> {
  const rd = _read(repo, file);
  if (!rd || !available()) return false;
  const ctx = await makeCtx(rd[0], rd[1]);
  if (!ctx) return false;
  // (a) a method-LEVEL annotation/decorator (in `modifiers`, or a sibling decorator) — NOT param/return ones.
  // NB: a method's NAME is the identifier right before its parameter list — NOT _name_of (which returns the
  // first name-kind child = the RETURN TYPE for `String foo()`; fine for classes, wrong for typed methods).
  const mname = (m: any): string => {
    const ch = ctx.children(m);
    const fp = ch.findIndex((c: any) => String(c.type).startsWith("formal_param"));
    if (fp > 0) for (let i = fp - 1; i >= 0; i--) if (ch[i].type === "identifier" || ch[i].type === "property_identifier") return ctx.text(ch[i]);
    return _name_of(ctx, m) ?? "";
  };
  const method = ctx.collect(ctx.root, (k) => _METHOD_KINDS.has(k)).find((m) => mname(m) === symbol);
  if (method) {
    const mods = ctx.children(method).find((c) => c.type === "modifiers");
    if (mods && ctx.children(mods).some((c) => _ANNOTATION.has(c.type))) return true;
    if (ctx.children(method).some((c) => _ANNOTATION.has(c.type))) return true;   // TS decorator sibling
  }
  // (b) enclosing class implements an interface NOT declared in-repo → framework callback impl.
  const idx = await _impl_index(repo);
  for (const cls of ctx.collect(ctx.root, (k) => _CLASS_KINDS.has(k))) {
    const impls: string[] = [];
    for (const h of ctx.children(cls)) {
      if (_IMPLEMENTS.has(h.type)) impls.push(...ctx.collect(h, (k) => _BASE_NAME.has(k)).map((n) => ctx.text(n)));
      else if (h.type === "class_heritage") for (const ec of ctx.children(h).filter((c) => _IMPLEMENTS.has(c.type))) impls.push(...ctx.collect(ec, (k) => _BASE_NAME.has(k)).map((n) => ctx.text(n)));
    }
    if (!impls.some((i) => !idx.interfaces.has(i))) continue;   // no external interface here
    if (_name_of(ctx, cls) === symbol) return true;
    if (method) { const [ms] = ctx.span(method); const [cs, ce] = ctx.span(cls); if (ms >= cs && ms <= ce) return true; }
  }
  return false;
}
