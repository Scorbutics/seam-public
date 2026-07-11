// SCAN phase — the DOWN / DEPENDENCY footprint (what a symbol delegates to / how it works): the anchor's
// imports, same-package type refs (Java siblings), DI interface→impl bindings, deterministic string-
// dispatch (tier-2), opt-in LLM coupling (tier-3), and the shared-key overlay. INTERNAL to the phase —
// the public entry is footprint.build_footprint. Port of build_dependency_graph.
import { basename, join } from "node:path";
import { statSync } from "node:fs";
import { _resolve_import, _resolve } from "../../core/resolve/consumers.js";
import { parse_imports, SKIP_DIRS, provider_for } from "../../core/resolve/languages/index.js";
import { normpath } from "../../core/resolve/walk.js";
import { resolveFileRef } from "../../core/resolve/file_ref.js";
import { type Ctx, makeCtx, available, lang_for, _TYPE_REF, _CLASS_KINDS, _INTERFACE } from "../atoms.js";
import type { EngineCtx } from "../engine_ctx.js";
import {
  type GraphNode, type GraphEdge, type Blindspot, type Provenance, type Unit, type ResolvedGraph, makeGraph,
} from "./graph.js";
import { expanduser, _read, _name_of, _named_units, _usage_lines, _call_lines } from "./ast_units.js";
import { _type_methods, _class_method_usage, _called_types } from "./ast_class.js";
import { impls_of, provider_accessors, is_provider_interface } from "./interface_index.js";
import { _annotationLo, _chain_route_consumers } from "./attach.js";
import { timingOn } from "../../core/progress.js";

type BuildOpts = {
  anchorLine?: number | null; useLlm?: boolean; model?: string; claudeBin?: string | null;
  dataCoupling?: boolean; dataCouplingLlm?: boolean; callerFiles?: string[]; ctx?: EngineCtx;
};

// The mutable accumulator every dependency pass shares: the growing graph (nodes/edges/blindspots), the
// node counter + dedup set, the parsed anchor (actx/aunits), and the per-file unit cache addDep populates.
interface DepScan {
  repo: string; anchorFile: string; symbol: string;
  actx: Ctx | null; aunits: Unit[];
  nodes: GraphNode[]; edges: GraphEdge[]; blindspots: Blindspot[];
  counter: number; seen: Set<string>; depUnits: Map<string, Unit[]>; externalPkgs: string[];
  calledTypes: Set<string>;   // names the anchor DELEGATES to (called) — vs payload type-refs (see _called_types)
}

// A dependency is DELEGATION (the call spine — `import`) when the anchor actually invokes it; otherwise it is a
// pure TYPE reference (a DTO/payload — `type-ref`), which the walk demotes so the budget follows the spine.
const _depEdgeKind = (s: DepScan, name: string): string => (s.calledTypes.has(name) ? "import" : "type-ref");

// Build the anchor (n1) node and its line range. Parses the anchor file to locate the symbol's def
// (kind + span), then narrows to an explicit anchorLine when one is given.
async function _anchorNode(anchorFile: string, symbol: string, ar: [string, string] | null,
    anchorLine: number | null): Promise<{ node: GraphNode; arange: number[] }> {
  let arange = [0, 0], akind = "symbol";
  if (ar && available()) {
    const ctx = await makeCtx(ar[0], ar[1]);
    if (ctx) { const defu = _named_units(ctx).find((u) => u[0] === symbol); if (defu) { akind = defu[1]; arange = [defu[2], defu[3]]; } }
  }
  if (anchorLine != null) arange = [anchorLine, Math.max(anchorLine, arange[1])];
  const node: GraphNode = { id: "n1", symbol, kind: akind, file: anchorFile, range: arange, enclosing: "", complexity: Math.max(1, arange[1] - arange[0] + 1) };
  return { node, arange };
}

// Turn one (referenced symbol → target file) into a dependency node + edge. Shared by the import pass and
// the same-package pass. Skips a target whose symbol is neither a recognised def nor has a line (can't
// place it), and self-references back to the anchor file.
async function _addDep(s: DepScan, refName: string, depFile: string, depLine: number | null,
    edgeKind = "import", provenance: Provenance = "RESOLVED_FULL", kindHint?: string): Promise<void> {
  if (s.seen.has(`${refName} ${depFile}`) || normpath(depFile) === normpath(s.anchorFile)) return;
  if (!s.depUnits.has(depFile)) {
    const rd = _read(s.repo, depFile);
    const dctx = rd ? await makeCtx(rd[0], rd[1]) : null;
    s.depUnits.set(depFile, dctx ? _named_units(dctx) : []);
  }
  const defu = s.depUnits.get(depFile)!.find((u) => u[0] === refName);
  let kind: string, rng: number[];
  if (defu) { kind = defu[1]; rng = [defu[2], defu[3]]; }
  else if (depLine != null) { kind = kindHint ?? "symbol"; rng = [depLine, depLine]; }
  else return;
  s.seen.add(`${refName} ${depFile}`);
  s.counter += 1;
  const did = `d${s.counter}`;
  s.nodes.push({ id: did, symbol: refName, kind, file: depFile, range: rng, enclosing: "", complexity: Math.max(1, rng[1] - rng[0] + 1) });
  const edge: GraphEdge = { from: "n1", to: did, kind: edgeKind, provenance };
  const call = s.actx ? (_usage_lines(s.actx, s.aunits, refName)[0] ?? null) : null;
  if (call != null) edge.line = call;
  s.edges.push(edge);
}

// 1) IMPORT pass — the symbols the anchor file explicitly imports. Unresolved targets are recorded as
// external packages (→ the external-libraries blindspot).
async function _importPass(s: DepScan, anchorSrc: string): Promise<void> {
  for (const ref of parse_imports(s.anchorFile, anchorSrc)) {
    const target = await _resolve_import(s.repo, s.anchorFile, ref);
    if (target === null || target[0] === null) {
      const ext = ref.source || ref.name;
      if (!s.externalPkgs.includes(ext)) s.externalPkgs.push(ext);
      continue;
    }
    await _addDep(s, ref.name, target[0], target[1], _depEdgeKind(s, ref.name));
  }
}

// 1b) FILE-PATH REFERENCE pass — a string literal in the anchor file that resolves to an EXISTING repo file
// is a dependency on that file: a component's view/style declaration (`templateUrl`/`styleUrls`), an asset
// `require('./logo.svg')`, a config path. FRAMEWORK-AGNOSTIC: the signal is "a path that points at a real
// file", never a property name — the same deterministic resolution as imports, just for non-code targets
// (so it links a `.js`/`.ts` component to its `.html`/`.css` regardless of framework). RESOLVED_FULL.
async function _fileRefPass(s: DepScan): Promise<void> {
  if (!s.actx) return;
  const seen = new Set<string>();
  for (const node of s.actx.collect(s.actx.root, (k: string) => k.includes("string"))) {
    const raw = s.actx.text(node);
    if (raw.includes("${") || raw.includes("\n")) continue;            // interpolated / multiline → not a clean literal
    const lit = raw.replace(/^[`'"]+|[`'"]+$/g, "").trim();
    if (!lit || seen.has(lit)) continue;
    seen.add(lit);
    const target = resolveFileRef(s.repo, s.anchorFile, lit);
    if (target) await _addDep(s, basename(target), target, 0, "file-ref", "RESOLVED_FULL", "file");
  }
}

// 2) SAME-PACKAGE pass — type references the body uses with NO import (Java needs no import for siblings:
// the controller→repository→entity-in-one-package case). Enumerate the type_identifier refs and resolve
// each BARE name via the active resolver — the Java floor maps it to a same-package sibling; import-style
// resolvers (TS/Python) return null for a bare name, so this is a no-op there.
async function _samePackagePass(s: DepScan): Promise<void> {
  if (!s.actx) return;
  const refNames = new Set<string>(s.actx.collect(s.actx.root, (k: string) => _TYPE_REF.has(k)).map((t: any) => s.actx!.text(t)));
  refNames.delete(s.symbol);
  for (const name of [...refNames].sort()) {
    const f = await _resolve(s.repo, s.anchorFile, name);
    if (f) await _addDep(s, name, f, null, _depEdgeKind(s, name));
  }
}

// 2b) CLASS/INTERFACE anchor — its "down" footprint is its OWN methods (how it works), NOT the return TYPES
// a body-wide _TYPE_REF scan surfaces. In a typed language the same-package pass sweeps up every method's
// return/param type (Java `BookingData loadBooking()` → BookingData / SubList / User), so the down spine read
// as those DTO types instead of the methods. Names come from the tree-sitter `name` field (cross-language via
// _named_units / _type_methods → _name_of), mirroring the consumers (UP) path, which already lists a class's
// methods. Runs INSTEAD of the same-package pass for a type anchor; imports + interface-impl still run.
//
// METHOD SCOPE — `callerFiles` (the files that REACHED this type during the grow walk) restricts the emitted
// methods to the ones those callers actually INVOKE (via a provable instance — _class_method_usage). This is
// the de-noise guard: the SEED/direct anchor (no callerFiles) shows the FULL class decomposition (the display
// fix), but a value/util class reached as a mere DEPENDENCY (a return type with no calls) no longer explodes
// into all of equals/hashCode/toString/serialize — only the method the caller really calls survives.
async function _typeMethodsPass(s: DepScan, callerFiles?: string[]): Promise<void> {
  if (!s.actx) return;
  const cls = s.actx.collect(s.actx.root, (k) => _CLASS_KINDS.has(k) || _INTERFACE.has(k)).find((c) => _name_of(s.actx!, c) === s.symbol);
  if (!cls) return;
  const [cs, ce] = s.actx.span(cls);
  // In-class methods (cross-language: Ruby `def`, C++ in-body function_definition, Java/TS methods) from the
  // unit scan, UNIONed with the interface-member fallback (_type_methods) so an interface's signatures
  // (TS `method_signature` / Java method_declaration) are covered too. Spans dedup by name.
  const spans = new Map<string, [number, number]>();
  // Exclude constructors as the UP path does: TS names them "constructor", Java/C++/C# name them after the
  // class (== s.symbol). _type_methods already drops `constructor_declaration` structurally.
  for (const [name, kind, ms, me] of s.aunits) if (kind === "method" && ms >= cs && me <= ce && name !== "constructor" && name !== s.symbol) spans.set(name, [ms, me]);
  for (const [name, ms, me] of _type_methods(s.actx, s.symbol)) if (!spans.has(name)) spans.set(name, [ms, me]);

  // Reached as a DEPENDENCY during the walk → keep only the methods the reaching callers actually invoke on a
  // provable instance of this class. Empty (a pure return-type ref, no call) → no method nodes at all.
  let allow: Set<string> | null = null;
  if (callerFiles && callerFiles.length) {
    allow = new Set<string>();
    const methodNames = new Set(spans.keys());
    if (methodNames.size) for (const cf of callerFiles) {
      const rd = _read(s.repo, cf);
      const cctx = rd ? await makeCtx(rd[0], rd[1]) : null;
      if (cctx) for (const m of Object.keys(_class_method_usage(cctx, s.symbol, methodNames))) allow.add(m);
    }
  }

  for (const [name, [ms, me]] of spans) {
    if (allow && !allow.has(name)) continue;
    if (s.seen.has(`${name} ${s.anchorFile}`)) continue;
    s.seen.add(`${name} ${s.anchorFile}`);
    s.counter += 1;
    const did = `d${s.counter}`;
    s.nodes.push({ id: did, symbol: name, kind: "method", file: s.anchorFile, range: [ms, me], enclosing: s.symbol, complexity: Math.max(1, me - ms + 1) });
    s.edges.push({ from: "n1", to: did, kind: "contains", provenance: "RESOLVED_FULL" });
  }
}

// 3) INTERFACE→IMPL pass — extend the footprint PAST a DI interface (@Inject/@Autowired/CDI) to its
// concrete implementation: the runtime binding a static scan can't see, recovered structurally from the
// `implements` relation. SOLE impl → a RESOLVED_PARTIAL `interface-impl` edge (it IS the runtime binding,
// just not statically asserted). MULTIPLE impls → an honest blindspot listing candidates (we don't guess
// which one the container wires). ZERO → left as-is (framework-generated, e.g. a Spring-Data repository:
// a genuine terminal blindspot).
// 2c) INTRA-FILE CALLEE pass (a FUNCTION/METHOD anchor only) — the anchor CALLS other functions/methods defined
// in the SAME file (a module of helpers: `get_pdf_text` → same-file `extract_text_with_pdftotext`/`pypdf`). Those
// callees have NO import and are NOT type-refs, so every pass above misses them and the anchor reads as a LEAF
// (its actual mechanism invisible — the gauntlet's cross-language gap). Resolve the anchor body's call sites
// against the file's OWN defs and add them as `call` deps. Cross-language (tree-sitter call-lines ⊕ named units).
function _intraFileCalleePass(s: DepScan): void {
  if (!s.actx) return;
  const anchor = s.aunits.find((u) => u[0] === s.symbol);
  if (!anchor) return;
  const [, , alo, ahi] = anchor;   // the anchor's own span
  // add the node/edge DIRECTLY — _addDep rejects same-file deps by design (a cross-file resolver guard), which is
  // exactly what blocked these; here the same file IS the answer.
  for (const [name, kind, dlo, dhi] of s.aunits) {
    if (name === s.symbol || (dlo >= alo && dlo <= ahi)) continue;             // itself / a NESTED def (not a callee)
    if (s.seen.has(`${name} ${s.anchorFile}`)) continue;                        // already added by another pass
    if (!_call_lines(s.actx, name).some((ln) => ln >= alo && ln <= ahi)) continue;   // the anchor body calls this same-file def
    s.seen.add(`${name} ${s.anchorFile}`);
    s.counter += 1;
    const did = `d${s.counter}`;
    s.nodes.push({ id: did, symbol: name, kind, file: s.anchorFile, range: [dlo, dhi], enclosing: "", complexity: Math.max(1, dhi - dlo + 1) });
    s.edges.push({ from: "n1", to: did, kind: "call", provenance: "RESOLVED_FULL", line: _call_lines(s.actx, name).find((ln) => ln >= alo && ln <= ahi) ?? dlo });
  }
}

// DETERMINISTIC rank of a multi-impl candidate set — NO intent/embeddings (the grow stays cacheable per file;
// the "which one for THIS question" is the render's job). Prefer CONCRETE, NON-TEST impls, structurally HEAVIEST
// first (file size = a cheap grounded proxy for a real mechanism vs a no-op/stub/map backend); path as a stable
// tiebreak. The heaviest concrete impls are the ones that actually cross a boundary (persist/HTTP/queue), which
// the downstream grounded coupling detection then confirms.
function _rankImpls(repo: string, cands: { cls: string; file: string }[]): { cls: string; file: string }[] {
  const isTest = (f: string) => /(^|\/)(test|tests|__tests__|src[/\\]test)([/\\]|$)/i.test(f);
  const size = (f: string) => { try { return statSync(join(repo, f)).size; } catch { return 0; } };
  return [...cands].map((c) => ({ c, test: isTest(c.file) ? 1 : 0, sz: size(c.file) }))
    .sort((a, b) => (a.test - b.test) || (b.sz - a.sz) || (a.c.file < b.c.file ? -1 : 1))
    .map((x) => x.c);
}

// 3) INTERFACE→IMPL pass. SOLE impl → the runtime binding, followed. MULTIPLE impls → the container's choice
// can't be picked statically, but PARKING them all left the whole layer behind a DI facade (Keycloak: `UserModel`
// → 6 impls, one the JPA persistence) invisible. Instead follow a DETERMINISTIC, CAPPED subset (the heaviest
// concrete impls — _rankImpls) so the footprint crosses into the real impl, and FLAG the impls NOT taken as a
// blindspot carrying their `{symbol,file}` so the dev can `--grow-from` them. SEAM_IMPL_CAP bounds the fan (0 =
// the old park-all behaviour). Deterministic ⇒ cacheable.
function _implCap(): number {
  const capRaw = parseInt(process.env.SEAM_IMPL_CAP ?? "3", 10);
  return Number.isFinite(capRaw) ? Math.max(0, capRaw) : 3;
}
// Follow ONE interface to its impl(s): sole impl → the runtime binding (RESOLVED_PARTIAL interface-impl edge);
// multiple → a DETERMINISTIC capped/ranked subset + a blindspot listing the rest. Shared by the @Inject field pass
// (_interfaceImplPass) and the DI provider-factory pass (_providerFactoryPass). Returns true if any impl existed.
async function _followInterface(s: DepScan, iface: string, cap: number, methods: Set<string> | string | null = null, line: number | null = null, edgeKind = "interface-impl"): Promise<boolean> {
  const cands = await impls_of(s.repo, iface);
  if (!cands.length) return false;
  // Bind ONE impl. METHOD-PRECISE: bind the impl's SPECIFIC method(s) the anchor actually calls (realm.createGroup →
  // RealmAdapter.createGroup; groups().createGroup() → JpaRealmProvider.createGroup) so the wave expands THAT method —
  // and its inner DI chain — and the crown lands on THAT method's persist (GroupEntity), not a sibling's in a
  // multi-interface mega-class (RoleEntity). Fall back to the class when none of the called methods is defined in this
  // impl (inherited/abstract, or a plain @Inject field with no chained call). `edgeKind` tags a provider-factory
  // binding distinctly (provider-impl) so the crown prefers the PROVIDER's persist over a co-bound adapter's write.
  const mset = methods == null ? null : (typeof methods === "string" ? new Set([methods]) : methods);
  const bind = async (c: { cls: string; file: string }) => {
    if (mset && mset.size) {
      let bound = false;
      for (const m of mset) { const n = s.nodes.length; await _addDep(s, m, c.file, line, edgeKind, "RESOLVED_PARTIAL"); if (s.nodes.length > n) bound = true; }
      if (bound) return;
    }
    await _addDep(s, c.cls, c.file, line, edgeKind, "RESOLVED_PARTIAL");
  };
  if (cands.length === 1) { await bind(cands[0]); return true; }
  const ranked = _rankImpls(s.repo, cands);
  const take = ranked.slice(0, cap), rest = ranked.slice(cap);
  for (const c of take) await bind(c);
  if (rest.length) s.blindspots.push({ node: iface, mechanism: "interface-multiple-impls",
    evidence: `${iface} has ${cands.length} implementations${take.length ? ` (followed ${take.length}, structurally-ranked)` : ""} — the runtime DI binding can't be picked statically; grow the rest explicitly`,
    candidates: rest.map((c) => ({ symbol: c.cls, file: c.file })) });
  return true;
}
// Method names the anchor INVOKES in its own span (qualified `x.m()` or bare `m()`), for a METHOD/FUNCTION anchor —
// a bounded body. Used to bind an interface to the impl's SPECIFIC method the anchor calls (method-precise DI).
function _anchorCalledMethods(s: DepScan): Set<string> {
  const called = new Set<string>();
  const u = s.aunits.find((x) => x[0] === s.symbol);
  if (!s.actx || !u || (u[1] !== "method" && u[1] !== "function")) return called;   // class anchor → keep class-level binding
  const [, , alo, ahi] = u;
  for (const c of s.actx.collect(s.actx.root, (k: string) => /invocation|call_expression/.test(k))) {
    const [cl] = s.actx.span(c);
    if (cl < alo || cl > ahi) continue;
    const nm = (c as any).childForFieldName?.("name");
    if (nm) called.add(s.actx.text(nm));
  }
  return called;
}
async function _interfaceImplPass(s: DepScan): Promise<void> {
  const cap = _implCap();
  const called = _anchorCalledMethods(s);
  for (const dn of [...s.nodes]) await _followInterface(s, dn.symbol, cap, called.size ? called : null);
}

// DI PROVIDER-FACTORY pass (DEFAULT-ON, opt out SEAM_PROVIDER_HOP=0) — follow a chained `session.groups().createGroup()` /
// `session.getProvider(X.class).create()` PAST the runtime factory to the interface's impls, so a DI-hidden
// persistence (Keycloak `session.groups()`→JpaRealmProvider→em.persist(GroupEntity)) is reached instead of leaving
// the spine stranded at the REST entry. GROUNDED, never a name guess: (a) the accessor form seeds ONLY on a method
// whose DECLARED return type is an in-repo interface WITH impls (provider_accessors); (b) the service-locator form
// seeds ONLY when the `X.class` argument IS such an interface. Reuses _followInterface, so the impl fan is the same
// capped/ranked/blindspotted set the @Inject pass produces. Runs per build (the wave expands each hop's node, so a
// multi-hop chain — RealmModel→RealmAdapter→session.groups()→GroupProvider — resolves as the walk descends).
async function _providerFactoryPass(s: DepScan): Promise<void> {
  if (process.env.SEAM_PROVIDER_HOP === "0" || !s.actx) return;   // DEFAULT-ON (opt out with =0); reaches DI-hidden persistence
  const anchor = s.aunits.find((u) => u[0] === s.symbol);
  if (!anchor) return;
  const [, , alo, ahi] = anchor;
  const cap = _implCap();
  const accessors = await provider_accessors(s.repo);
  const isInv = (k: string) => /invocation|call_expression/.test(k);
  const nameOf = (n: any): string => { const f = n?.childForFieldName?.("name"); return f ? s.actx!.text(f) : ""; };
  // The interface named by a `<Iface>.class` argument (Java class-literal, from the file's LanguageProvider —
  // languages/java/resolve.ts). This is the GROUNDING for the service-locator form — NOT the method name: any
  // call passing a provider interface's class literal (`getProvider(X.class)`, `getInstance(X.class)`,
  // `getComponent(X.class)`, …) is a DI lookup. Grounding on the ARG TYPE, not a hardcoded `getProvider|getBean|…`
  // list, keeps this framework-agnostic (the impl set comes from the interface registry). undefined on a
  // language with no class-literal form (TS/Ruby/Python) ⇒ never matches, same as before.
  const classLiteralArg = provider_for(s.anchorFile)?.classLiteralArg;
  const classArg = (inv: any): string | null => {
    const args = inv?.childForFieldName?.("arguments"); if (!args || !classLiteralArg) return null;
    return classLiteralArg(s.actx!.text(args));
  };
  // CHAINED provider calls in the anchor span: `x.groups().createGroup(...)` / `getProvider(X.class).create(...)` →
  // (interface, chained method). This is what lets the hop bind the impl's SPECIFIC method, not the whole class. The
  // interface is grounded structurally — a provider ACCESSOR's declared return type, or a `.class` ARG that IS a
  // provider interface — never a method-name guess.
  const chained = new Map<string, Set<string>>();   // interface → chained method names
  const addChain = (i: string, m: string) => { if (m) (chained.get(i) ?? chained.set(i, new Set()).get(i)!).add(m); };
  const called = new Set<string>();                 // provider ACCESSOR names called (chained or bare)
  const classCands: { x: string; method: string | null }[] = [];   // (`X.class` interface candidate, chained method | null)
  for (const outer of s.actx.collect(s.actx.root, isInv)) {
    const [cl] = s.actx.span(outer); if (cl < alo || cl > ahi) continue;
    const obj = (outer as any).childForFieldName?.("object");   // the receiver (Java method_invocation)
    if (obj && isInv(obj.type) && accessors.has(nameOf(obj))) { const on = nameOf(obj); called.add(on); for (const i of accessors.get(on)!) addChain(i, nameOf(outer)); }
    else if (obj && isInv(obj.type)) { const x = classArg(obj); if (x) classCands.push({ x, method: nameOf(outer) }); }   // `m(X.class).chained()`
    else { const on = nameOf(outer); if (accessors.has(on)) called.add(on); else { const x = classArg(outer); if (x) classCands.push({ x, method: null }); } }
  }
  // Keep only `.class` candidates that ARE provider interfaces (grounded on the arg type — the framework-agnostic gate).
  const locators = new Set<string>();
  for (const { x, method } of classCands) { if (!(await is_provider_interface(s.repo, x))) continue; if (method) addChain(x, method); else locators.add(x); }
  const seeded = new Set<string>();
  const seed = async (iface: string, method: string | null) => {
    const key = `${iface}#${method ?? ""}`; if (seeded.has(key)) return; seeded.add(key);
    await _followInterface(s, iface, cap, method, null, "provider-impl");   // tag DI provider-factory bindings distinctly
  };
  // METHOD-PRECISE first (a chained call), then the CLASS-level fallback for a bare accessor/locator with no chain.
  for (const [i, ms] of chained) for (const m of ms) await seed(i, m);
  for (const m of called) for (const i of accessors.get(m) ?? []) if (!chained.has(i)) await seed(i, null);
  for (const x of locators) if (!chained.has(x) && await is_provider_interface(s.repo, x)) await seed(x, null);
}

// Summarise the unresolved imports gathered by the import pass into one blindspot.
function _externalLibsBlindspot(s: DepScan): void {
  if (!s.externalPkgs.length) return;
  const shown = s.externalPkgs.slice(0, 8).join(", ") + (s.externalPkgs.length > 8 ? " …" : "");
  s.blindspots.push({ node: "n1", mechanism: "external-libraries",
    evidence: `${s.symbol} uses ${s.externalPkgs.length} external/stdlib dependenc${s.externalPkgs.length === 1 ? "y" : "ies"}: ${shown}`, candidates: [] });
}

// Tier-2 string-dispatch (deterministic): a string literal in the body naming a UNIQUE module entry →
// RESOLVED_PARTIAL; ambiguous → a blind spot. (Tier-3 LLM discovery is gated on use_llm.)
async function _stringDispatchPass(s: DepScan, lo: number, hi: number): Promise<void> {
  if (!s.actx) return;
  try {
    const sc = await import("./string_coupling.js");
    const entryIdx = sc.module_entry_index(s.repo, SKIP_DIRS);
    const [scEdges, scAmbig] = sc.detect(s.actx, lo, hi, entryIdx, s.anchorFile);
    for (const [name, path, line] of scEdges) {
      if (s.seen.has(`${name} ${path}`)) continue;
      s.seen.add(`${name} ${path}`);
      s.counter += 1;
      const did = `d${s.counter}`;
      const entry = await sc.entry_line(s.repo, path);
      s.nodes.push({ id: did, symbol: name, kind: "module", file: path, range: [entry, entry], enclosing: "", complexity: 1 });
      s.edges.push({ from: "n1", to: did, kind: "dispatch", provenance: "RESOLVED_PARTIAL", line });
    }
    for (const [name, hits] of scAmbig) {
      s.blindspots.push({ node: "n1", mechanism: "string-dispatch-ambiguous",
        evidence: `'${name}' names ${hits.length} module entries (ambiguous)`,
        candidates: hits.map((h) => ({ file: h, symbol: name, provenance: "SUGGESTED" })) });
    }
  } catch { /* tree-sitter unavailable → skip tier-2 */ }
}

// Tier-3 LLM discovery (opt-in): residual file couplings the LLM proposes, GROUNDED to real repo paths →
// SUGGESTED blind-spot candidates (never resolved edges).
async function _llmDiscoveryPass(s: DepScan, anchorSrc: string, lo: number, hi: number, opts: BuildOpts): Promise<void> {
  const { discover } = await import("./llm_discovery.js");
  const resolvedFiles = s.nodes.filter((n) => n.id !== "n1").map((n) => n.file);
  for (const c of discover(s.repo, s.anchorFile, anchorSrc, lo, hi, resolvedFiles, { model: opts.model, claudeBin: opts.claudeBin })) {
    s.blindspots.push({ node: "n1", mechanism: "llm-suggested-coupling", evidence: c.evidence,
      candidates: [{ file: c.file, symbol: basename(c.file.split("/").slice(0, -1).join("/")) || c.file, provenance: "SUGGESTED" }] });
  }
}

// Shared-key boundary: keys this anchor produces/consumes ground into boundary nodes + crossing fans
// toward the other side (readers/writers), then route consumers are chained on. (anchor's framework keys
// come from the CACHED key index — _carrier_extra → anchorKeys — not a per-anchor LLM call.)
async function _dataCouplingPass(s: DepScan, anchorSrc: string, arange: number[], opts: BuildOpts): Promise<void> {
  const keyLo = _annotationLo(anchorSrc, arange[0]);   // include a route/entry annotation above the def
  const dc = await import("../coupling/index.js");
  const dcDelta = await dc.resolveCoupling(s.repo, "n1", s.anchorFile, anchorSrc, keyLo, arange[1], s.counter, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, opts.ctx);
  s.nodes.push(...dcDelta.nodes); s.edges.push(...dcDelta.edges); s.blindspots.push(...dcDelta.blindspots); s.counter = dcDelta.counter;
  s.counter = await _chain_route_consumers(s.repo, s.nodes, s.edges, s.counter);
}

export async function build_dependency_graph(repo: string, anchorFile: string, symbol: string,
    opts: BuildOpts = {}): Promise<ResolvedGraph> {
  repo = expanduser(repo);
  const ar = _read(repo, anchorFile);
  const { node: anchor, arange } = await _anchorNode(anchorFile, symbol, ar, opts.anchorLine ?? null);
  const nodes: GraphNode[] = [anchor], edges: GraphEdge[] = [], blindspots: Blindspot[] = [];

  if (ar && available()) {
    const actx = await makeCtx(ar[0], ar[1]);
    const s: DepScan = {
      repo, anchorFile, symbol, actx, aunits: actx ? _named_units(actx) : [],
      nodes, edges, blindspots, counter: 0, seen: new Set(), depUnits: new Map(), externalPkgs: [],
      calledTypes: actx ? _called_types(actx) : new Set<string>(),
    };
    // Per-pass timing — split a slow large-repo dependency build (interface-impl index vs same-package vs
    // data-coupling). --verbose / SEAM_TIMING only; same diagnostic style as [dc-timing]/[index-cache].
    const _dt = () => (timingOn() ? performance.now() : 0);
    const _de = (l: string, t: number) => { if (t) process.stderr.write(`[dep-pass] ${symbol} ${l}: ${Math.round(performance.now() - t)}ms\n`); };
    // A CLASS/INTERFACE anchor decomposes DOWN into its own methods; a function/method anchor into the
    // same-package types its body references. Detected structurally from the parse (not the def-table kind,
    // which labels interfaces "class" too) — covers any class/interface/struct/enum/record in _CLASS_KINDS.
    const isType = !!actx && actx.collect(actx.root, (k) => _CLASS_KINDS.has(k) || _INTERFACE.has(k)).some((c) => _name_of(actx, c) === symbol);
    let _t = _dt();
    await _importPass(s, ar[0]); _de("import", _t); _t = _dt();
    await _fileRefPass(s); _de("fileRef", _t); _t = _dt();
    if (isType) { await _typeMethodsPass(s, opts.callerFiles); _de("typeMethods", _t); }
    else { await _samePackagePass(s); _intraFileCalleePass(s); _de("samePackage+intraCallee", _t); }
    _t = _dt();
    await _providerFactoryPass(s); _de("providerFactory", _t); _t = _dt();   // DI factory hop (default-on, opt out =0), before the @Inject pass
    await _interfaceImplPass(s); _de("interfaceImpl", _t); _t = _dt();
    _externalLibsBlindspot(s);
    await _stringDispatchPass(s, arange[0], arange[1]); _de("stringDispatch", _t); _t = _dt();
    if (opts.useLlm) await _llmDiscoveryPass(s, ar[0], arange[0], arange[1], opts);
    if (opts.dataCoupling !== false) { await _dataCouplingPass(s, ar[0], arange, opts); _de("dataCoupling", _t); }
  }

  return makeGraph({ id: "n1", symbol, file: anchorFile, range: arange }, lang_for(anchorFile) ?? "", nodes, edges, { anchors: ["n1"], blindspots });
}
