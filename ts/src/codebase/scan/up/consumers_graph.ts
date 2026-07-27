// SCAN phase — the UP / CONSUMERS footprint (where a symbol is used). build_resolved_graph is the
// deterministic import-scan core (+ intra-file usages + the depth-2 ripple + the coupling overlay);
// build_consumers_graph wraps it, merging the receiver-agnostic call-site pass for interface/method/class
// anchors the import scan is blind to. INTERNAL to the phase — the public entry is footprint.build_footprint.
import {
  type Ctx, makeCtx, available, lang_for,
  _INTERFACE, _CLASS_KINDS, _CLASS_FIELD,
} from "../../atoms.js";
import { scan_consumers, _kind_for, defaultExportSlot, default_importers } from "../../../core/resolve/consumers.js";
import { timingOn } from "../../../core/progress.js";
import type { EngineCtx } from "../../engine_ctx.js";
import {
  type GraphNode, type GraphEdge, type Blindspot, type Unresolved, type Provenance, type ResolvedGraph,
  type Unit, makeGraph,
} from "../../graph.js";
import {
  expanduser, stem, _read, _name_of, _named_units, _wrappedDefSpan, _enclosing, _usage_lines, _call_lines, _ref_lines_split,
} from "../../ast_units.js";
import { importBindsElsewhere } from "../def_resolve.js";
import { _class_methods } from "../ast_class.js";
import { _annotationLo, _depth2_ripple, _chain_route_consumers } from "../attach.js";
import { fileReferencers } from "../../../core/resolve/file_ref.js";
import { normpath } from "../../../core/resolve/walk.js";
import { endsWithSourceExt } from "../../../core/resolve/languages/index.js";
import {
  build_class_graph, build_callsite_graph, _callsite_new_consumers_only, _reconcile_class_attribution,
} from "./class_graph.js";

type BuildOpts = {
  depth?: number; verified?: any; anchorLine?: number | null;
  dataCoupling?: boolean; dataCouplingLlm?: boolean; ctx?: EngineCtx; model?: string; claudeBin?: string | null;
  skipCallsite?: boolean;   // skip the receiver-agnostic call-site pass (an UNCACHED repo walk parsing every file
                            // with the symbol's method names — minutes for a hub class). For blast-radius counts
                            // (review-impact) the import-resolved consumers suffice; DI-dispatched callers are lost.
};

export async function build_resolved_graph(repo: string, anchorFile: string, symbol: string, opts: BuildOpts = {}): Promise<ResolvedGraph> {
  const depth = opts.depth ?? 1;
  repo = expanduser(repo);
  const nodes: GraphNode[] = [], edges: GraphEdge[] = [], blindspots: Blindspot[] = [], unresolved: Unresolved[] = [];

  let arange = [0, 0];
  let akind = "symbol";
  let actx: Ctx | null = null;
  let aunits: Unit[] = [];
  const ar = _read(repo, anchorFile);
  if (ar && available()) {
    actx = await makeCtx(ar[0], ar[1]);
    if (actx) {
      aunits = _named_units(actx);
      const defu = aunits.find((u) => u[0] === symbol);
      if (defu) { akind = defu[1]; arange = [defu[2], defu[3]]; }
      else { const w = _wrappedDefSpan(actx, symbol, aunits); if (w) { akind = "function"; arange = w; } }   // `const X = withReporting(realFn)` → the real impl span (not :0)
    }
  }
  if (opts.anchorLine != null) arange = [opts.anchorLine, Math.max(opts.anchorLine, arange[1])];
  if (akind === "class") return build_class_graph(repo, anchorFile, symbol, { depth, verified: opts.verified, dataCoupling: opts.dataCoupling, dataCouplingLlm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin, ctx: opts.ctx });   // forward ctx so the floor index is reused, not rebuilt per class anchor
  const aencl = akind === "method" ? (aunits.find((u) => u[1] === "class" && u[2] <= arange[0] && arange[1] <= u[3])?.[0] ?? "") : "";
  nodes.push({ id: "n1", symbol, kind: akind, file: anchorFile, range: arange, enclosing: aencl, complexity: Math.max(1, arange[1] - arange[0] + 1) });

  let counter = 1;
  // Sub-step timing (--verbose, or the narrow SEAM_TIMING) — so a slow grow step on a real repo can be
  // split into its parts: consumer resolution (repo walk + tree-sitter parse of each consumer) vs data-
  // coupling (shared-key index + the route-chain repo walks). Coarse, stderr-only, off by default.
  const _bt = () => (timingOn() ? performance.now() : 0);
  const _bemit = (label: string, t0: number) => { if (t0) process.stderr.write(`[build-timing] ${symbol}: ${label} ${Math.round(performance.now() - t0)}ms\n`); };
  let _bt0 = _bt();
  const seenKeys = new Map<string, string>();
  for (const con of await scan_consumers(repo, anchorFile, symbol)) {
    if (con.status === "SUGGESTED") {
      blindspots.push({ node: "n1", mechanism: "unresolved-import",
        evidence: `${con.file} imports ${symbol} from '${con.source}' (module unresolved)`, candidates: [{ symbol: con.file }] });
      unresolved.push({ node: "n1", query: "resolveModule", reason: `unresolved:${con.source}` });
      continue;
    }
    const rd = _read(repo, con.file);
    if (!rd) continue;
    const cctx = await makeCtx(rd[0], rd[1]);
    if (!cctx) continue;
    const units = _named_units(cctx);
    let lines = _usage_lines(cctx, units, con.local);
    // NO USAGE IN A BODY — the bare BARREL / re-export case (`export { X } from "./x"`), and the plain
    // "imported but only re-bound" one. The import statement IS a real, locatable site in the consumer's own
    // file, and the resolver already grounded its 0-based line (Consumer.line, from parse_imports), so cite
    // THAT. `0` remains a SENTINEL for "no site at all" (no line from the resolver either): it must never
    // reach an EDGE nor be rendered — 0 is not a valid line, and after the 0-based→1-based conversion it
    // reads as `file:1`, a FABRICATED citation pointing at an unrelated first line. Nodes placed on the
    // sentinel are marked `unlocated` so every projection can omit the location instead of inventing one.
    let grounded = lines.length > 0;
    if (!lines.length && con.line != null) { lines = [con.line]; grounded = true; }
    if (!lines.length) lines = [0];
    for (const ln of lines) {
      const enc = _enclosing(units, ln);
      let name: string, kind: string, start: number, end: number, cls: string;
      if (enc) {
        [name, kind, start, end] = enc;
        cls = units.find((u) => u[1] === "class" && u[2] <= start && end <= u[3])?.[0] ?? "";
      } else { name = stem(con.file); kind = "module"; start = ln; end = ln; cls = ""; }
      const key = `${con.file}#${name}#${start}`;
      if (seenKeys.has(key)) continue;
      counter += 1;
      const cid = `n${counter}`;
      seenKeys.set(key, cid);
      nodes.push({ id: cid, symbol: name, kind: _kind_for(con.file, kind), file: con.file, range: [start, end], enclosing: cls, complexity: Math.max(1, end - start + 1),
        ...(grounded ? {} : { unlocated: true as const }) });
      // carry the USAGE line (0-based, the internal convention) so the SET projection can cite where the symbol
      // is actually used rather than the consuming unit's declaration — see project_set's line contract.
      edges.push({ from: cid, to: "n1", kind: "reference", provenance: "RESOLVED_FULL", ...(grounded ? { line: ln } : {}) });
    }
  }
  // REVERSE FILE-PATH REFERENCE — the up/consumers side of file_ref: source files that name THIS file by a
  // path literal (a controller's `templateUrl`, a component's `styleUrls`, …) are its consumers, so a
  // template/asset anchor reaches its owner. Gated to NON-source anchors — a code file's users come through
  // the import scan above; only template/asset files are reached by path and need this (so the repo-wide
  // reference index is built only when it pays). Framework-agnostic (resolveFileRef, no property names).
  if (!endsWithSourceExt(anchorFile)) {
    for (const ref of fileReferencers(repo, anchorFile)) {
      if (normpath(ref.file) === normpath(anchorFile)) continue;
      const key = `${ref.file}#fileref`;
      if (seenKeys.has(key)) continue;
      counter += 1; const cid = `n${counter}`; seenKeys.set(key, cid);
      nodes.push({ id: cid, symbol: stem(ref.file), kind: "module", file: ref.file, range: [ref.line, ref.line], enclosing: "", complexity: 1 });
      edges.push({ from: cid, to: "n1", kind: "file-ref", provenance: "RESOLVED_FULL" });
    }
  }
  // Intra-file usages: a same-file function that USES `symbol` is a real consumer the import scan
  // can't see — no import edge (intra-module), and scan_consumers / build_callsite_graph skip the
  // anchor file. A direct CALL is deterministic (RESOLVED_FULL); any other reference (passed as a
  // callback, stored in a dispatch table, aliased) is only a heuristic name match → RESOLVED_PARTIAL.
  // Each enclosing caller becomes a RESOLVED link so a leaf/private helper still grows UP to its
  // caller (a later grow step traces that caller to ITS own importers). Gated on a real definition
  // range: without one (interface / not found) `arange` is [0,0], so `implements`/type-annotation
  // name matches couldn't be excluded. Calls/refs inside the anchor's own body (recursion) and the
  // definition itself fall inside `arange` and are skipped; a caller already wired by a FULL call is
  // not re-added by a weaker reference (first write wins, so FULL is never downgraded to PARTIAL).
  if (actx && akind !== "symbol") {
    const addCaller = (ln: number, kind: string, provenance: Provenance) => {
      if (ln >= arange[0] && ln <= arange[1]) return;
      const enc = _enclosing(aunits, ln);
      if (!enc || enc[0] === symbol) return;
      const [name, ukind, start, end] = enc;
      const key = `${anchorFile}#${name}#${start}`;
      if (seenKeys.has(key)) return;
      counter += 1;
      const cid = `n${counter}`;
      seenKeys.set(key, cid);
      nodes.push({ id: cid, symbol: name, kind: _kind_for(anchorFile, ukind), file: anchorFile, range: [start, end], enclosing: "", complexity: Math.max(1, end - start + 1) });
      // Always grounded here (unlike the import path above): `ln` came from _call_lines/_ref_lines, i.e. an
      // actual usage site in the anchor's own file — there is no "resolved but unused" case to guard against.
      edges.push({ from: cid, to: "n1", kind, provenance, line: ln });   // the call/reference line, not the caller's decl
    };
    // NAME COLLISION with an IMPORT. The name match above is only sound while the anchor OWNS the bare name in
    // its own file. When the file also IMPORTS that name, the import is the module-scope binding, so every BARE
    // `symbol(...)` there is provably the IMPORTED symbol — a different thing that merely shares the name — and
    // attributing it to the anchor is a false RESOLVED_FULL "verified edge" (cal.com: the METHOD
    // RegularBookingService.createBooking vs `import { createBooking } from "../handleNewBooking/createBooking"`,
    // called bare at :1939). Only the BARE sites are dropped: a receiver-qualified `this.symbol()` / `x.symbol()`
    // is a member access, never the import, so genuine same-file method callers survive. Proof-gated — an
    // unresolved module leaves the old behaviour intact, so no false positive is traded for a false negative.
    const refs = _ref_lines_split(actx, symbol);
    const importBound = ar ? await importBindsElsewhere(repo, anchorFile, ar[0], symbol) : false;
    const callLines = new Set(importBound ? [] : _call_lines(actx, symbol));   // _call_lines is bare-name only by construction
    for (const ln of callLines) addCaller(ln, "call", "RESOLVED_FULL");
    const refLines = importBound ? refs.qualified : [...new Set([...refs.bare, ...refs.qualified])].sort((a, b) => a - b);
    for (const ln of refLines) if (!callLines.has(ln)) addCaller(ln, "reference", "RESOLVED_PARTIAL");
  }
  // OPAQUE DEFAULT SLOT — the honest middle answer between asserting and lying. When this file's `export
  // default` is an EXPRESSION that resolves to no declaration of the file (an anonymous `() => …`, a wrapper
  // whose impl argument is not a local funclike), its default importers are real consumers that NO symbol here
  // can carry. Reported only when the anchor otherwise has ZERO edges — i.e. exactly where the render would
  // otherwise say "Nothing in the repo calls this symbol" — so it can never inflate a non-empty answer. The
  // provable wrapper form (`export default withReporting(getSlots, "getSlots")`) is resolved upstream by the
  // default-export slot in core/resolve/consumers.ts and never reaches here.
  if (!edges.length) {
    const slot = defaultExportSlot(repo, anchorFile);
    if (slot.expr && !slot.local) {
      const imps = await default_importers(repo, anchorFile);
      if (imps.length) blindspots.push({ node: "n1", mechanism: "opaque-default-export",
        evidence: `${anchorFile} has \`export default ${slot.expr}\` — an expression this file declares no name for, so its `
          + `${imps.length} default-import consumer(s) cannot be attributed to ${symbol} or to any other symbol here`,
        candidates: imps.slice(0, 8).map((f) => ({ symbol: f })) });
    }
  }
  if (depth >= 2 && available()) {
    const [d2n, d2e, c2] = await _depth2_ripple(repo, nodes.slice(1), counter, seenKeys);
    counter = c2; nodes.push(...d2n); edges.push(...d2e);
  }
  _bemit("consumers (walk+parse)", _bt0); _bt0 = _bt();
  // Shared-key boundary: if the anchor PRODUCES/CONSUMES a DB table, surface the other side (readers/
  // writers) as crossings the grow can follow. The deterministic adapter floor runs by default; the
  // LLM key front-end (--data-coupling llm) adds cross-framework proposals into the same machinery.
  if (opts.dataCoupling !== false && ar) {
    const dc = await import("../../coupling/index.js");
    // When the symbol resolved to a def range, scan it (widened over a leading route/entry annotation).
    // When it did NOT (arange stays [0,0] — e.g. the "symbol" is an AngularJS controller-NAME string, not
    // a real def), fall back to the WHOLE FILE so a `$http.get("/…")` inside an anonymous callback still
    // surfaces rather than the anchor reading as isolated.
    const resolved = arange[1] > 0;
    const keyLo = resolved ? _annotationLo(ar[0], arange[0]) : 0;
    const keyHi = resolved ? arange[1] : (ar[0].match(/\n/g) ?? []).length;
    // coupling owns its grounding + boundary resolution and returns a delta; a warm `.seam` covers the
    // anchor side on a deterministic run too.
    const dcDelta = await dc.resolveCoupling(repo, "n1", anchorFile, ar[0], keyLo, keyHi, counter, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, opts.ctx);
    nodes.push(...dcDelta.nodes); edges.push(...dcDelta.edges); blindspots.push(...dcDelta.blindspots); counter = dcDelta.counter;
    _bemit("data-coupling resolve (index+attach)", _bt0); _bt0 = _bt();
    counter = await _chain_route_consumers(repo, nodes, edges, counter);
    _bemit("data-coupling route-chain", _bt0);
  }

  return makeGraph({ id: "n1", symbol, file: anchorFile, range: arange }, lang_for(anchorFile) ?? "", nodes, edges, { depth, blindspots, unresolved });
}

// UP / consumers — for a plain function/class this is build_resolved_graph; an INTERFACE also merges
// its method call-sites (the DI/abstraction usage the import scan can't see). Port of build_consumers_graph.
export async function build_consumers_graph(repo: string, anchorFile: string, symbol: string, opts: BuildOpts = {}): Promise<ResolvedGraph> {
  let base = await build_resolved_graph(repo, anchorFile, symbol, opts);
  const ar = _read(repo, anchorFile);
  if (ar && available()) {
    const ctx = await makeCtx(ar[0], ar[1]);
    if (ctx) {
      const isInterface = ctx.collect(ctx.root, (k) => _INTERFACE.has(k)).some((c) => _name_of(ctx, c) === symbol);
      // A METHOD anchor is never an import binding, so build_resolved_graph (import-scan) is blind to
      // `instance.method()` callers — the receiver may come from DI, a factory, or a base class
      // (`engine.generate()` where engine: MissionEngine extends Engine). Merge the same receiver-
      // agnostic call-site pass interfaces already use, scoped to this one method → RESOLVED_PARTIAL.
      // METHOD-LIKE also covers a class FIELD holding a function — `m = withReporting(this._m.bind(this))`,
      // `m = (x) => …` — the HOF/telemetry-wrapper idiom. Such a field is NOT a method node (it never reaches
      // _named_units), so `isMethod` was false, the receiver-agnostic call-site pass never ran, and `consumers`
      // returned 0 for a symbol with real callers. MEASURED cost of that empty answer: an agent refused to accept
      // "0", tried 5 more query shapes hunting for signal, and burned 8 calls on a 1-call question. Callers still
      // write `instance.m(...)`, so the same call-site pass scoped to this NAME recovers them (RESOLVED_PARTIAL).
      const isFieldFn = !isInterface && ctx.collect(ctx.root, (k) => _CLASS_FIELD.has(k))
        .some((f: any) => _name_of(ctx, f) === symbol);
      const isMethod = !isInterface && (isFieldFn || _named_units(ctx).some((u) => u[0] === symbol && u[1] === "method"));
      // A CLASS anchor IS an import binding, so build_class_graph attributes the methods it can tie to a
      // provable instance (a typed var / `new C()`). The residual — a method dispatched on an instance
      // obtained via factory/DI or as a base-class array element (`new C()` pushed into a `Base[]` looped
      // as `x.m()`) — is exactly what it cannot attribute, so it emits `method-unattributed-consumers` /
      // `untraced-or-unused-methods`. Run the SAME call-site pass (narrowed to C's subclass family) so
      // those consumers surface as RESOLVED_PARTIAL call edges — a followable lead, not a candidate-less
      // blind spot — then reconcile the two blind spots against what the pass recovered.
      const isClass = !isInterface && !isMethod && ctx.collect(ctx.root, (k) => _CLASS_KINDS.has(k)).some((c) => _name_of(ctx, c) === symbol);
      if (!opts.skipCallsite && (isInterface || isMethod || isClass)) {
        const { merge_resolved } = await import("../expand.js");
        let callsite = await build_callsite_graph(repo, anchorFile, symbol,
          { anchorLine: opts.anchorLine, methodNames: isMethod ? new Set([symbol]) : undefined, ownerClass: isClass ? symbol : undefined });
        if (isClass) callsite = _callsite_new_consumers_only(base, callsite, symbol);   // additive: keep only the consumers build_class_graph could NOT attribute
        base = merge_resolved(base, callsite);
        if (isClass) _reconcile_class_attribution(base, callsite, symbol, _class_methods(ctx, symbol).map((m) => m[0]));
      }
    }
  }
  return base;
}
