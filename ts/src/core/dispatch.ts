// CROSS-LANGUAGE CALL-RESOLUTION VOCABULARY + the shared resolution algorithm. The grammar-specific
// INDEX BUILD (which node kinds are classes/methods) stays per-language, but the resolution machinery
// (ancestor-chain lookup, by-name over-approximation, tiering) is identical once a class is reduced to
// `{ parents, methods }` — so it lives here and ALL simple-name languages (Java, TypeScript) share it.
// Ruby's richer model (mixin MRO + class re-opening + const nesting) keeps its own lookup but reuses the
// candidate shape + by-name leaf. Tiered by the one provenance ladder (core/resolution).
import { isResolved, type Provenance } from "./resolution.js";

export type MethodKind = "instance" | "class";

export interface MethodCandidate {
  className: string;   // FQN of the owning class/module, e.g. "Yuki::VD"
  method: string;
  file: string;        // repo-relative
  line: number;        // 0-based def line
  kind: MethodKind;
  tier: Provenance;    // RESOLVED_FULL = a pinned unique hit; PARTIAL/SUGGESTED = an over-approximation
}

// The PINNED candidates — the only tier a precise call-graph consumer follows. Following an unpinned
// (by-name) candidate would fabricate an edge from a coincidental name clash.
export const pinned = (cands: MethodCandidate[]): MethodCandidate[] => cands.filter((c) => isResolved(c.tier));

// ── The common index shape every language's index satisfies (Ruby ClassInfo, Java/TS ClassNode) ──────
// One method def location. The minimal shape the language-agnostic carrier machinery reads.
export interface MethodDef { kind: MethodKind; file: string; line: number }
// A class/module the agnostic machinery can walk: where it lives + its methods. (Ruby adds nesting/mixins
// on top; the carrier engine only needs this slice.)
export interface IndexedClass { file: string; methods: Map<string, MethodDef> }
export type MethodIndex = Map<string, IndexedClass>;   // keyed by the language's class key (FQN or simple name)

// `index.get(class).methods.get(method)` — generic across every language's index.
export const methodDef = (index: MethodIndex, className: string, method: string): MethodDef | null =>
  index.get(className)?.methods.get(method) ?? null;
// Every method name DEFINED anywhere in the repo (for the "is this unresolved name a real carrier?" test).
export function repoMethodNames(index: MethodIndex): Set<string> {
  const out = new Set<string>();
  for (const info of index.values()) for (const m of info.methods.keys()) out.add(m);
  return out;
}
// The class key whose method def is the nearest above `row` in `file` — the enclosing scope of a call
// (so a self/bare call resolves against the right type). `fallback` = the module/top-level scope.
export function enclosingClass(index: MethodIndex, file: string, row: number, fallback: string | null): string | null {
  let best = fallback, span = Infinity;
  for (const [key, info] of index) {
    for (const d of info.methods.values()) if (d.file === file && d.line <= row && (row - d.line) < span) { best = key; span = row - d.line; }
  }
  return best;
}

// ── The simple-name dispatch shared by Java + TypeScript ──────────────────────────────────────────────
export const MODULE = "";   // synthetic key for top-level (module-scope) functions

// A class reduced to its resolved parent keys (superclass + interfaces/mixins) + methods. The simple-name
// languages build this directly; ancestor lookup is then a plain walk over `parents`.
export interface ClassNode extends IndexedClass { name: string; line: number; parents: string[] }
export type DispatchIndex = Map<string, ClassNode>;

// Ancestor-chain lookup: own methods → parents (superclass + interfaces), recursively. First hit, RESOLVED_FULL.
export function lookupMethod(index: DispatchIndex, key: string, method: string, seen = new Set<string>()): MethodCandidate | null {
  if (seen.has(key) || seen.size > 64) return null;
  seen.add(key);
  const info = index.get(key);
  if (!info) return null;
  const own = info.methods.get(method);
  if (own) return { className: key, method, file: own.file, line: own.line, kind: own.kind, tier: "RESOLVED_FULL" };
  for (const p of info.parents) { const h = lookupMethod(index, p, method, seen); if (h) return h; }
  return null;
}

// All defs of `method` repo-wide — the over-approximation when the receiver type is unknown.
export function byName(index: DispatchIndex, method: string): MethodCandidate[] {
  const out: MethodCandidate[] = [];
  for (const info of index.values()) { const d = info.methods.get(method); if (d) out.push({ className: info.name, method, file: d.file, line: d.line, kind: d.kind, tier: "SUGGESTED" }); }
  return out;
}
// Unknown receiver → tiered by candidate count: 1 ⇒ RESOLVED_PARTIAL, N ⇒ SUGGESTED.
export function resolveByName(index: DispatchIndex, method: string): MethodCandidate[] {
  const all = byName(index, method);
  return all.length === 1 ? [{ ...all[0], tier: "RESOLVED_PARTIAL" }] : all;
}

// A self/`this`/module-scope call → its def via the ancestor chain.
export const resolveSelf = (index: DispatchIndex, key: string, method: string): MethodCandidate[] => {
  const h = lookupMethod(index, key, method);
  return h ? [h] : [];
};

// Resolve `recvExpr.method(...)`: a Type receiver (`Store`) → class lookup; a var with an inferred type
// (`s : Store`) → instance lookup; else the by-name over-approximation. Shared by Java + TypeScript.
export function resolveSimpleCall(index: DispatchIndex, recvExpr: string, method: string, typeOf: Map<string, string>): MethodCandidate[] {
  if (/^[A-Z]/.test(recvExpr) && index.has(recvExpr)) { const h = lookupMethod(index, recvExpr, method); if (h) return [h]; }
  else { const t = typeOf.get(recvExpr); if (t && index.has(t)) { const h = lookupMethod(index, t, method); if (h) return [h]; } }
  return resolveByName(index, method);
}

// ── The simple-name INDEX BUILD shared by Java + TypeScript ───────────────────────────────────────────
// The thin grammar layer: which node kinds are containers/methods, and how to read names/parents from them.
export interface IndexGrammar {
  containerKinds: Set<string>;
  methodKinds: Set<string>;             // method nodes attached to the enclosing container
  moduleMethodKinds?: Set<string>;      // top-level function nodes → MODULE scope (TS)
  className(node: any): string | null;
  parentNames(node: any): string[];     // superclass + interface simple names
  methodName(node: any, container: string): string | null;
  methodKind(node: any): MethodKind;
}
const _row = (n: any): number => n.startPosition.row;
export function buildSimpleIndex(roots: Iterable<{ root: any; file: string }>, g: IndexGrammar): DispatchIndex {
  const index: DispatchIndex = new Map();
  const ensure = (name: string, file: string, line: number): ClassNode => {
    let i = index.get(name);
    if (!i) { i = { name, file, line, parents: [], methods: new Map() }; index.set(name, i); }
    return i;
  };
  for (const { root, file } of roots) {
    const visit = (n: any, current: string | null) => {
      if (g.containerKinds.has(n.type)) {
        const name = g.className(n);
        if (name) {
          const info = ensure(name, file, _row(n));
          for (const p of g.parentNames(n)) if (!info.parents.includes(p)) info.parents.push(p);
          for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), name);
          return;
        }
      }
      if (g.methodKinds.has(n.type) && current != null) { const mn = g.methodName(n, current); if (mn) ensure(current, file, _row(n)).methods.set(mn, { kind: g.methodKind(n), file, line: _row(n) }); return; }
      if (g.moduleMethodKinds?.has(n.type) && current == null) { const mn = g.methodName(n, MODULE); if (mn) ensure(MODULE, file, _row(n)).methods.set(mn, { kind: "instance", file, line: _row(n) }); return; }
      for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), current);
    };
    visit(root, null);
  }
  return index;
}
