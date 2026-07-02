// SCAN phase — the CLASS-anchor footprints. build_class_graph attributes each consumer's method calls to a
// provable instance; build_callsite_graph is the receiver-agnostic call-site pass (DI/factory/base-class
// dispatch the import scan can't see), with subclass-family narrowing to promote/demote provenance. Plus
// the two reconcilers that merge the call-site pass into a class base, and the LSP candidate emitter.
// INTERNAL to the phase (white-box tested) — the public entry is footprint.build_footprint.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { scan_consumers, _kind_for } from "../../core/resolve/consumers.js";
import { endsWithSourceExt, SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { incrementalScanAsync } from "../../core/resolve/index_cache.js";
import { normpath, walk } from "../../core/resolve/walk.js";
import { makeCtx, available, lang_for, sameLangFamily, _CLASS_KINDS, _INTERFACE } from "../atoms.js";
import { dbg } from "../../core/progress.js";
import type { EngineCtx } from "../engine_ctx.js";
import {
  type GraphNode, type GraphEdge, type Blindspot, type Unresolved, type Unit, type ResolvedGraph, makeGraph,
} from "./graph.js";
import { expanduser, stem, _read, _name_of, _named_units, _enclosing, _usage_lines } from "./ast_units.js";
import {
  _class_methods, _class_method_usage, _class_call_sites, _type_methods, _class_bases,
  _instance_types, _method_call_sites, _subclass_family, _called_method_names,
} from "./ast_class.js";
import { _annotationLo, _depth2_ripple, _chain_route_consumers } from "./attach.js";

const _CLASS_CONSUMER_PARSE_CAP = 120;   // parse at most this many consumers for method attribution (rest = module nodes); bounds a hub class's per-run parse cost

// INVERTED CALL-SITE INDEX — `method name → files that call it` + the repo's `class → base classes` map.
// build_callsite_graph used to WALK + readFileSync + text-scan the WHOLE repo on EVERY method/class up-build to
// find caller files and the inheritance map — MEASURED at ~400ms/up-build, ~68% of a grow on a 7411-file repo.
// Built ONCE per repo (cached + persisted to `.seam/callsite-index.json`, content-keyed, O(changed) warm), so a
// build looks up its candidate consumers instead of re-reading the repo. Same `makeCtx` parse cache as the rest.
interface CallIndex { callers: Map<string, string[]>; bases: Map<string, string[]>; }
const _callIndexCache = new Map<string, CallIndex>();
export function resetCallIndex(): void { _callIndexCache.clear(); }
async function _callIndex(repo: string): Promise<CallIndex> {
  let ci = _callIndexCache.get(repo);
  if (ci) return ci;
  const scan = async (rel: string, text: string): Promise<{ calls: string[]; bases: [string, string[]][] }> => {
    const cctx = await makeCtx(text, lang_for(rel) ?? "");
    return cctx ? { calls: _called_method_names(cctx), bases: _class_bases(cctx) } : { calls: [], bases: [] };
  };
  const callers = new Map<string, string[]>(), bases = new Map<string, string[]>();
  for (const { rel, data } of await incrementalScanAsync(repo, SKIP_DIRS, endsWithSourceExt, "callsite-v1", scan, "callsite-index")) {
    for (const m of data.calls) { const a = callers.get(m); if (a) a.push(rel); else callers.set(m, [rel]); }
    for (const [cls, bs] of data.bases) bases.set(cls, bs);
  }
  ci = { callers, bases };
  _callIndexCache.set(repo, ci);
  return ci;
}

// CALL-SITE discovery: anchor (class/interface/method) + every place a consumer CALLS one of its
// methods, regardless of how the receiver was obtained (DI/factory/interface/base class). Edges are
// RESOLVED_PARTIAL by default; when `opts.ownerClass` is given (a METHOD anchor), a call whose
// receiver provably resolves to the owner or one of its subclasses is promoted to RESOLVED_FULL,
// leaving only genuinely ambiguous same-named calls at PARTIAL. When `opts.methodNames` is given
// those names ARE the method set — the symbol is a single method to hunt for, not a type.
export async function build_callsite_graph(repo: string, anchorFile: string, symbol: string,
    opts: { anchorLine?: number | null; methodNames?: Set<string>; ownerClass?: string | null } = {}): Promise<ResolvedGraph> {
  repo = expanduser(repo);
  const ar = _read(repo, anchorFile);
  if (!ar || !available()) throw new Error(`cannot parse anchor ${anchorFile}`);
  const actx = (await makeCtx(ar[0], ar[1]))!;
  const aunits = _named_units(actx);
  let arange = [0, 0], akind = "symbol";
  const defu = aunits.find((u) => u[0] === symbol);
  if (defu) { akind = defu[1]; arange = [defu[2], defu[3]]; }
  else {
    const ifc = actx.collect(actx.root, (k) => _INTERFACE.has(k)).find((c) => _name_of(actx, c) === symbol);
    if (ifc) { akind = "interface"; arange = actx.span(ifc); }
  }
  // For a method anchor, surface its owning class so the seam reads `Engine.generate`, not a bare method.
  const aencl = defu && defu[1] === "method"
    ? (aunits.find((u) => u[1] === "class" && u[2] <= defu[2] && defu[3] <= u[3])?.[0] ?? "")
    : "";
  if (opts.anchorLine != null) arange = [opts.anchorLine, Math.max(opts.anchorLine, arange[1])];
  const methods = opts.methodNames ?? new Set(_type_methods(actx, symbol).map((m) => m[0]));

  const nodes: GraphNode[] = [{ id: "n1", symbol, kind: akind, file: anchorFile, range: arange, enclosing: aencl, complexity: Math.max(1, arange[1] - arange[0] + 1) }];
  const edges: GraphEdge[] = [];
  const base = (n: GraphNode[], e: GraphEdge[]): ResolvedGraph =>
    makeGraph({ id: "n1", symbol, file: anchorFile, range: arange }, lang_for(anchorFile) ?? "", n, e);
  if (!methods.size) return base(nodes, edges);

  // Narrowing target: the method anchor's owning class (aencl). When set, receiver-resolved calls are
  // promoted to FULL. An explicit opts.ownerClass overrides; null keeps the receiver-agnostic PARTIAL
  // behaviour interfaces rely on (a DI seam genuinely cannot know the concrete impl statically).
  const owner = opts.ownerClass ?? (opts.methodNames && aencl ? aencl : null);
  const anchorAbs = normpath(join(repo, anchorFile));

  // Candidate consumer files come from the cached inverted index (files that CALL one of the methods); the
  // repo's class→bases map is cached too — so we parse only the candidates (makeCtx-cached) instead of walking +
  // re-reading the whole repo. A candidate that won't parse is surfaced (its calls then never resolve).
  const idx = await _callIndex(repo);
  const globalBases = idx.bases;
  // CROSS-LANGUAGE GATE: the call index is a repo-wide method-NAME map (every language). A same-named call
  // in a DIFFERENT language family is not a real consumer — a Java class's `data()`/`response()` cannot be
  // invoked from a `.js` controller's `x.data`; that reach, if any, is an HTTP/FFI BOUNDARY the coupling
  // overlay owns, not a structural call. Without this, a test/base class whose methods share generic names
  // fans its "consumers" out to every JS/other-lang file that happens to use those names (the observed
  // 211-node seed of a pdf/xslt scenario TEST pulling in bookings/login/company controllers). Grounded on
  // the language registry (a closed structural fact), so it degrades identically for every language.
  const anchorLang = lang_for(anchorFile);
  const candidates = new Set<string>();
  for (const m of methods) for (const rel of idx.callers.get(m) ?? []) if (sameLangFamily(lang_for(rel), anchorLang)) candidates.add(rel);
  const pending: { rel: string; fn: string; units: Unit[]; instTypes: Map<string, Set<string>>; sites: ReturnType<typeof _method_call_sites> }[] = [];
  for (const rel of candidates) {
    if (normpath(join(repo, rel)) === anchorAbs) continue;
    const rd = _read(repo, rel);
    if (!rd) continue;
    const cctx = await makeCtx(rd[0], rd[1]);
    if (!cctx) { dbg(`[callsite] SKIPPED unparseable candidate consumer ${rel} — its calls to ${[...methods].join("/")} are NOT resolved`); continue; }
    const sites = _method_call_sites(cctx, methods);
    if (sites.length) pending.push({ rel, fn: rel.split("/").pop()!, units: _named_units(cctx), instTypes: owner ? _instance_types(cctx) : new Map(), sites });
  }

  const family = owner ? _subclass_family(globalBases, owner) : null;
  const inFamily = (s: { recvId: string | null; recvNew: string | null }, instTypes: Map<string, Set<string>>): boolean => {
    if (!family) return false;
    if (s.recvNew && family.has(s.recvNew)) return true;
    if (s.recvId) { const ts = instTypes.get(s.recvId); if (ts && [...ts].some((t) => family.has(t))) return true; }
    return false;
  };
  // Provably-SIBLING receivers: a concrete class that shares the owner's in-repo base(s) but is not the
  // owner or one of its subclasses dispatches to a DIFFERENT override of the same-named method — it is not
  // a consumer of THIS class. Dropping those sites (vs keeping them PARTIAL) stops a generic method name
  // (`score`) from dragging in every sibling's call sites (e.g. each scorer's own unit tests). A receiver
  // typed as the bare base, or unresolved (factory / DI / untyped loop var over `Base[]`), stays PARTIAL —
  // that ambiguity is real. Empty when the owner has no in-repo base (nothing to be a sibling of), which
  // preserves the unrelated-same-name → PARTIAL contract (a class sharing no base is never a sibling).
  const ownerBases = owner ? (globalBases.get(owner) ?? []) : [];
  const siblings = new Set<string>();
  for (const b of ownerBases) for (const c of _subclass_family(globalBases, b)) siblings.add(c);
  for (const c of family ?? []) siblings.delete(c);   // keep the owner + its subclasses
  for (const b of ownerBases) siblings.delete(b);      // keep the bare base (polymorphic — could be the owner)
  const provablySibling = (s: { recvId: string | null; recvNew: string | null }, instTypes: Map<string, Set<string>>): boolean => {
    if (!siblings.size) return false;
    if (s.recvNew) return siblings.has(s.recvNew);
    if (s.recvId) { const ts = instTypes.get(s.recvId); if (ts && ts.size && [...ts].every((t) => siblings.has(t))) return true; }
    return false;
  };

  // Dedup by enclosing unit; a unit holding ANY family-resolved call is FULL (the strongest evidence
  // wins over a sibling ambiguous call in the same function).
  const byKey = new Map<string, { sym: string; kind: string; start: number; end: number; rel: string; full: boolean }>();
  const resolvedMethods = new Set<string>();   // every method name a call site was found for (any provenance)
  for (const pf of pending) {
    for (const s of pf.sites) {
      if (provablySibling(s, pf.instTypes)) continue;   // a sibling's own dispatch — not a consumer of this class
      resolvedMethods.add(s.method);
      const enc = _enclosing(pf.units, s.line);
      const [sym, kind, start, end] = enc ? enc : [stem(pf.fn), "module", s.line, s.line];
      const key = `${pf.rel}#${sym}#${start}`;
      const full = inFamily(s, pf.instTypes);
      const cur = byKey.get(key);
      if (cur) cur.full = cur.full || full;
      else byKey.set(key, { sym, kind, start, end, rel: pf.rel, full });
    }
  }
  let counter = 0;
  for (const v of byKey.values()) {
    counter += 1;
    nodes.push({ id: `c${counter}`, symbol: v.sym, kind: _kind_for(v.rel, v.kind), file: v.rel, range: [v.start, v.end], enclosing: "", complexity: Math.max(1, v.end - v.start + 1) });
    edges.push({ from: `c${counter}`, to: "n1", kind: "call", provenance: v.full ? "RESOLVED_FULL" : "RESOLVED_PARTIAL" });
  }
  // `resolvedMethods` is read by build_consumers_graph BEFORE merge_resolved (which copies only
  // nodes/edges/blindspots/unresolved/anchors), so it never leaks into a merged graph / oracle.
  return { ...base(nodes, edges), resolvedMethods: [...resolvedMethods].sort() };
}

// For a CLASS anchor, build_class_graph already wires every consumer it could attribute to a provable
// instance (a `reference`→`Class.method` edge). The call-site pass re-finds those AND the unattributed
// ones; keep only the latter so the merge is purely additive (no duplicate class-level `call` edge next
// to an existing method-level `reference`). Filter at file granularity: a file already method-attributed
// is considered covered. Always keeps the call-site anchor node (n1, deduped onto the class on merge).
export function _callsite_new_consumers_only(base: any, callsite: any, className: string): any {
  const fileOf = new Map<string, string>((base.nodes ?? []).map((n: any) => [n.id, n.file]));
  const attributedFiles = new Set<string>((base.edges ?? [])
    .filter((e: any) => e.kind === "reference" && typeof e.to === "string" && e.to.startsWith(`${className}.`))
    .map((e: any) => fileOf.get(e.from)).filter(Boolean));
  const keep = new Set<string>((callsite.nodes ?? [])
    .filter((n: any) => n.id === "n1" || !attributedFiles.has(n.file)).map((n: any) => n.id));
  return { ...callsite,
    nodes: (callsite.nodes ?? []).filter((n: any) => keep.has(n.id)),
    edges: (callsite.edges ?? []).filter((e: any) => keep.has(e.from) && keep.has(e.to)) };
}

// After merging build_callsite_graph into a CLASS anchor's build_class_graph base, retire the two blind
// spots the call-site pass made stale. build_class_graph marks an UNATTRIBUTED consumer with a weak
// `reference`→class edge (no method could be tied to a provable instance); a consumer the call-site pass
// now reaches as a `call` edge is no longer unattributed, so its file drops from `method-unattributed-
// consumers` and its weak reference edge (now redundant) is removed. A method the pass found a call site
// for drops from `untraced-or-unused-methods`. A blind spot whose list empties is removed entirely; a
// genuinely-unused method (e.g. `audit` nobody calls) or an import-only consumer correctly survives.
export function _reconcile_class_attribution(g: any, callsite: any, className: string, allMethods: string[]): void {
  const resolvedFiles = new Set<string>((callsite.nodes ?? []).filter((n: any) => n.id !== "n1" && n.file).map((n: any) => n.file));
  const resolvedMethods = new Set<string>(callsite.resolvedMethods ?? []);
  const fileOf = new Map<string, string>((g.nodes ?? []).map((n: any) => [n.id, n.file]));
  // build_class_graph marks an unattributed consumer with a bare `reference`→class edge. Files so flagged
  // = the `method-unattributed-consumers` set; the ones the call-site pass recovered are now redundant.
  const untracedFiles = new Set<string>(), supersededIds = new Set<string>();
  for (const e of g.edges ?? []) {
    if (e.to !== className || e.kind !== "reference") continue;
    const f = fileOf.get(e.from);
    if (!f) continue;
    untracedFiles.add(f);
    if (resolvedFiles.has(f)) supersededIds.add(e.from);   // a precise call-site node now covers this consumer
  }
  // Drop the redundant weak reference edge, then the build_class_graph consumer node it left orphaned
  // (the call-site pass's enclosing-unit node — e.g. `make` — supersedes the coarse module-level one).
  g.edges = (g.edges ?? []).filter((e: any) => !(e.kind === "reference" && e.to === className && supersededIds.has(e.from)));
  const incident = new Set<string>((g.edges ?? []).flatMap((e: any) => [e.from, e.to]));
  g.nodes = (g.nodes ?? []).filter((n: any) => !(supersededIds.has(n.id) && !incident.has(n.id)));

  const usedMethods = new Set<string>((g.nodes ?? [])
    .filter((n: any) => n.kind === "method" && n.enclosing === className).map((n: any) => n.symbol));
  const remainingUnused = allMethods.filter((m) => !usedMethods.has(m) && !resolvedMethods.has(m)).sort();
  const remainingUnattr = [...untracedFiles].filter((f) => !resolvedFiles.has(f)).sort();

  g.blindspots = (g.blindspots ?? []).filter((b: any) =>
    b.mechanism !== "untraced-or-unused-methods" && b.mechanism !== "method-unattributed-consumers");
  if (remainingUnused.length) g.blindspots.push({ node: className, mechanism: "untraced-or-unused-methods",
    evidence: `${remainingUnused.length} of ${allMethods.length} methods have no traced consumer (unused, or used via an instance we couldn't trace): ${remainingUnused.join(", ")}`,
    candidates: [] });
  if (remainingUnattr.length) g.blindspots.push({ node: className, mechanism: "method-unattributed-consumers",
    evidence: `${remainingUnattr.length} consumer(s) import ${className} as a RESOLVED reference but no method call could be attributed to an instance (factory/DI/dynamic): ${remainingUnattr.join(", ")}`,
    candidates: [] });
}

// class_call_candidates: every consumer call-site whose method matches a method of `className`, with
// its position — the extension's LSP verification input (--emit-candidates). Pure scan.
export async function class_call_candidates(repo: string, anchorFile: string, className: string): Promise<{ file: string; line: number; col: number; method: string }[]> {
  repo = expanduser(repo);
  const ar = _read(repo, anchorFile);
  if (!ar || !available()) return [];
  const methods = new Set(_class_methods((await makeCtx(ar[0], ar[1]))!, className).map((m) => m[0]));
  if (!methods.size) return [];
  const out: { file: string; line: number; col: number; method: string }[] = [];
  for (const con of await scan_consumers(repo, anchorFile, className)) {
    if (con.status !== "RESOLVED_FULL") continue;
    const rd = _read(repo, con.file);
    if (!rd) continue;
    const cctx = await makeCtx(rd[0], rd[1]);
    if (!cctx) continue;
    for (const [method, line, col] of _class_call_sites(cctx, methods)) out.push({ file: con.file, line, col, method });
  }
  return out;
}

export async function build_class_graph(repo: string, anchorFile: string, className: string,
    opts: { depth?: number; verified?: any; dataCoupling?: boolean; dataCouplingLlm?: boolean; ctx?: EngineCtx; model?: string; claudeBin?: string | null } = {}): Promise<ResolvedGraph> {
  const depth = opts.depth ?? 1;
  repo = expanduser(repo);
  const ar = _read(repo, anchorFile);
  if (!ar || !available()) throw new Error(`cannot parse class anchor ${anchorFile}`);
  const ctx = (await makeCtx(ar[0], ar[1]))!;
  const cls = ctx.collect(ctx.root, (k) => _CLASS_KINDS.has(k)).find((c) => _name_of(ctx, c) === className) ?? null;
  const crange = cls ? ctx.span(cls) : [0, 0];
  const methods = _class_methods(ctx, className);
  const methodNames = new Set(methods.map((m) => m[0]));
  const methodSpan = new Map(methods.map((m) => [m[0], [m[1], m[2]] as [number, number]]));

  const blindspots: Blindspot[] = [], unresolved: Unresolved[] = [];
  const pending: [string, string, string, number, number, Record<string, number>, string][] = [];
  const usedMethods = new Set<string>();
  // PARSE CAP — a HUB class (e.g. a Repository consumed by 500+ files) would otherwise tree-sitter-parse
  // every consumer just to attribute method calls — minutes on a big repo, EVERY run (the parse isn't disk-
  // cached). Parse the first N for precise method attribution; emit the rest as lightweight MODULE nodes
  // (no parse) so the consumer COUNT / fan-in stays accurate. Method-level precision degrades past the cap
  // (a `method-attribution-capped` blind spot says so), the blast-radius magnitude does not.
  const allCons = await scan_consumers(repo, anchorFile, className);
  let parsed = 0, capped = 0;
  for (const con of allCons) {
    if (con.status === "SUGGESTED") {
      blindspots.push({ node: className, mechanism: "unresolved-import",
        evidence: `${con.file} imports ${className} from '${con.source}' (module unresolved)`, candidates: [{ symbol: con.file }] });
      unresolved.push({ node: className, query: "resolveModule", reason: `unresolved:${con.source}` });
      continue;
    }
    if (parsed >= _CLASS_CONSUMER_PARSE_CAP) {   // past the cap → a lightweight module node (counts, but no method attribution)
      pending.push([con.file, stem(con.file), "module", 0, 0, {}, "RESOLVED_FULL"]); capped++;
      continue;
    }
    const rd = _read(repo, con.file);
    if (!rd) continue;
    const cctx = await makeCtx(rd[0], rd[1]);
    if (!cctx) continue;
    parsed++;
    let usage: Record<string, number>;
    const v = opts.verified ? Object.fromEntries(Object.entries(opts.verified[con.file] ?? {}).filter(([m]) => methodNames.has(m))) : {};
    if (opts.verified != null && Object.keys(v).length) usage = v as Record<string, number>;
    else usage = Object.fromEntries(Object.entries(_class_method_usage(cctx, className, methodNames)).filter(([m]) => methodNames.has(m)));
    const prov = "RESOLVED_FULL";
    const units = _named_units(cctx);
    const line = Object.keys(usage).length ? Math.min(...Object.values(usage)) : (_usage_lines(cctx, units, con.local)[0] ?? 0);
    const enc = _enclosing(units, line);
    const [sym, kind, start, end] = enc ? enc : [stem(con.file), "module", line, line];
    pending.push([con.file, sym, kind, start, end, usage, prov]);
    for (const m of Object.keys(usage)) usedMethods.add(m);
  }
  if (capped) blindspots.push({ node: className, mechanism: "method-attribution-capped",
    evidence: `${className} has ${allCons.length} consumers; method-level usage was attributed for the first ${_CLASS_CONSUMER_PARSE_CAP} (the other ${capped} are counted but not method-traced — a hub, review by impact)`, candidates: [] });

  const nodes: GraphNode[] = [{ id: className, symbol: className, kind: "class", file: anchorFile, range: crange, enclosing: "", complexity: Math.max(1, crange[1] - crange[0] + 1) }];
  const edges: GraphEdge[] = [];
  for (const mn of [...usedMethods].sort()) {
    const [s, e] = methodSpan.get(mn)!;
    nodes.push({ id: `${className}.${mn}`, symbol: mn, kind: "method", file: anchorFile, range: [s, e], enclosing: className, complexity: Math.max(1, e - s + 1) });
    edges.push({ from: `${className}.${mn}`, to: className, kind: "contains", provenance: "RESOLVED_FULL" });
  }
  const unused = [...methodNames].filter((m) => !usedMethods.has(m));
  if (unused.length) {
    blindspots.push({ node: className, mechanism: "untraced-or-unused-methods",
      evidence: `${unused.length} of ${methodNames.size} methods have no traced consumer (unused, or used via an instance we couldn't trace): ${[...unused].sort().join(", ")}`,
      candidates: [] });
  }

  let counter = 0;
  const nMethods = usedMethods.size;
  const untraced: string[] = [];
  const seenKeys = new Map<string, string>();
  for (const [cfile, sym, kind, start, end, usage] of pending) {
    counter += 1;
    const cid = `c${counter}`;
    seenKeys.set(`${cfile}#${sym}#${start}`, cid);
    nodes.push({ id: cid, symbol: sym, kind: _kind_for(cfile, kind), file: cfile, range: [start, end], enclosing: "", complexity: Math.max(1, end - start + 1) });
    if (Object.keys(usage).length) {
      for (const mn of Object.keys(usage).sort()) edges.push({ from: cid, to: `${className}.${mn}`, kind: "reference", provenance: "RESOLVED_FULL", line: usage[mn] });
    } else { edges.push({ from: cid, to: className, kind: "reference", provenance: "RESOLVED_FULL" }); untraced.push(cfile); }
  }
  if (untraced.length) {
    blindspots.push({ node: className, mechanism: "method-unattributed-consumers",
      evidence: `${untraced.length} consumer(s) import ${className} as a RESOLVED reference but no method call could be attributed to an instance (factory/DI/dynamic): ${[...untraced].sort().join(", ")}`,
      candidates: [] });
  }
  if (depth >= 2) {
    const [d2n, d2e, c2] = await _depth2_ripple(repo, nodes.slice(1 + nMethods), counter, seenKeys);
    counter = c2; nodes.push(...d2n); edges.push(...d2e);
  }

  // Shared-key boundary for a CLASS anchor — a `@WebServlet("/x")`/`@Path("/x")` handler is container-
  // invoked (no static caller), so its only link to the rest of the app is the ROUTE it serves. Run the
  // same data-coupling pass the symbol path uses, scanning the class span (incl. its route annotation).
  if (opts.dataCoupling !== false) {
    const dc = await import("../coupling/index.js");
    const keyLo = _annotationLo(ar[0], crange[0]);
    const dcDelta = await dc.resolveCoupling(repo, className, anchorFile, ar[0], keyLo, crange[1], counter, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, opts.ctx);
    nodes.push(...dcDelta.nodes); edges.push(...dcDelta.edges); blindspots.push(...dcDelta.blindspots); counter = dcDelta.counter;
    counter = await _chain_route_consumers(repo, nodes, edges, counter);
  }

  return makeGraph({ id: className, symbol: className, file: anchorFile, range: crange }, lang_for(anchorFile) ?? "", nodes, edges, { depth, blindspots, unresolved });
}
