// RUBY QUALIFIED-CALL / METHOD RESOLUTION (deterministic floor) — resolves `recv.meth(...)` to the
// method definition(s), the gap that blocks carrier-tracing (teacher 1) on Ruby. NO ruby-lsp: a
// repo-wide tree-sitter index (classes/modules → superclass + mixins + methods) plus light scoped
// receiver-type inference (`x = Foo.new` ⇒ `x : Foo`, `Foo.bar` ⇒ class Foo) plus an ancestor-chain
// lookup (own → includes/prepends → superclass).
//
// Dispatch is over-approximated HONESTLY via a candidate set tiered by provenance — never a single
// asserted guess. A PINNED receiver type with a unique chain hit → RESOLVED_FULL (the only tier a precise
// call-graph consumer should assert); an unknown receiver → the method's defs repo-wide, RESOLVED_PARTIAL
// (1) or SUGGESTED (N). Truly-dynamic dispatch (send/method_missing/define_method) is out of scope here
// and stays an honest blindspot for the carrier-tracer to mark. The over-approximation is safe for the
// sink-reaching goal (union the candidates) and quarantined from the precise graph by the tier.
import { field, getParser } from "../../core/treesitter.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../core/resolve/languages/base.js";
import type { MethodCandidate, MethodKind } from "../../core/dispatch.js";
import type { Provenance } from "../../core/resolution.js";

export type { MethodCandidate, MethodKind } from "../../core/dispatch.js";

interface MethodDef { kind: MethodKind; file: string; line: number }
interface Mixin { name: string; mode: "include" | "prepend" | "extend" }
interface ClassInfo {
  fqn: string;
  file: string;
  line: number;
  superclass: string | null;       // raw name as written (relative to the def's nesting)
  nesting: string[];               // enclosing namespace parts at the def site (for relative const lookup)
  mixins: Mixin[];
  methods: Map<string, MethodDef>; // method name → def (last definition wins on re-open)
}
export type RubyIndex = Map<string, ClassInfo>; // keyed by class/module FQN

// One `x = Foo.new` / `@iv = Foo::Bar.new` style assignment — the receiver-type evidence.
export interface RubyAssign { name: string; fqn: string; line: number }

const _CONTAINER = new Set(["class", "module"]);
const _DYNAMIC = new Set(["send", "__send__", "public_send"]);
export const isDynamicDispatch = (method: string): boolean => _DYNAMIC.has(method);

const _row = (n: any): number => n.startPosition.row;

// A constant reference node → its written name: `constant` ("VD") or `scope_resolution` ("Yuki::VD").
// Exported: the carrier tracer reads constant receivers the same way (`Marshal.dump`).
export function constName(n: any): string | null {
  if (!n) return null;
  if (n.type === "constant") return n.text;
  if (n.type === "scope_resolution") {
    const scope = field(n, "scope"), name = field(n, "name");
    const s = scope ? constName(scope) : "";          // absent scope = leading `::` (top-level)
    return s ? `${s}::${name?.text ?? ""}` : (name?.text ?? null);
  }
  return null;
}

// `include`/`prepend`/`extend Foo` calls in a class body → mixins (the closed structural set).
function _mixinOf(call: any): Mixin | null {
  if (call.type !== "call" || field(call, "receiver")) return null; // only bare `include Foo`, no receiver
  const m = field(call, "method");
  const mode = m?.text as Mixin["mode"];
  if (mode !== "include" && mode !== "prepend" && mode !== "extend") return null;
  const args = field(call, "arguments");
  const first = args && args.namedChildCount ? args.namedChild(0) : null;
  const name = constName(first);
  return name ? { name, mode } : null;
}

// Ruby top-level methods are private instance methods of Object — index them under this synthetic FQN.
const _TOPLEVEL = "Object";

// Walk one parsed Ruby file, merging classes/modules into the index (Ruby re-opens classes across files).
function _indexFile(root: any, file: string, index: RubyIndex): void {
  const ensure = (fqn: string, nesting: string[], line: number): ClassInfo => {
    let info = index.get(fqn);
    if (!info) { info = { fqn, file, line, superclass: null, nesting: [...nesting], mixins: [], methods: new Map() }; index.set(fqn, info); }
    return info;
  };
  // `nesting` = the namespace parts CONTAINING the node (e.g. ["Yuki","VD"] inside class VD in module Yuki).
  const visit = (n: any, nesting: string[]) => {
    if (_CONTAINER.has(n.type)) {
      const name = constName(field(n, "name"));
      if (name) {
        const fqn = [...nesting, name].join("::");
        const info = ensure(fqn, nesting, _row(n));
        const sc = field(n, "superclass");
        if (sc && !info.superclass) { const scName = constName(sc.namedChildCount ? sc.namedChild(0) : sc); if (scName) info.superclass = scName; }
        for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), [...nesting, name]);
        return;
      }
    }
    if (n.type === "method" || n.type === "singleton_method") {
      const mn = field(n, "name")?.text;
      if (mn) ensure(nesting.length ? nesting.join("::") : _TOPLEVEL, nesting.slice(0, -1), _row(n))
        .methods.set(mn, { kind: n.type === "singleton_method" ? "class" : "instance", file, line: _row(n) });
      return; // don't index method-local nested defs
    }
    if (n.type === "call") { const mx = _mixinOf(n); if (mx) { const info = ensure(nesting.length ? nesting.join("::") : _TOPLEVEL, nesting.slice(0, -1), _row(n)); if (!info.mixins.some((e) => e.name === mx.name && e.mode === mx.mode)) info.mixins.push(mx); } }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), nesting);
  };
  visit(root, []);
}

// Build the repo-wide Ruby class/method index (one parse per .rb file). Graceful: parse failures skip.
export async function buildRubyIndex(repo: string): Promise<RubyIndex> {
  const parser = await getParser("ruby");
  const index: RubyIndex = new Map();
  if (!parser) return index;
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, (r) => r.endsWith(".rb") || r.endsWith(".rake"))) {
    let root: any;
    try { root = parser.parse(text).rootNode; } catch { continue; }
    _indexFile(root, rel, index);
  }
  return index;
}

// Known stdlib FACTORIES that return their receiver type (so `@f = File.open(p)` ⇒ `@f : File`). A
// closed, registry-sourced set — distinct from generic `Const.new` (where the type IS the receiver).
const _FACTORY: Record<string, string> = {
  "File.open": "File", "File.new": "File", "IO.open": "IO", "IO.new": "IO",
  "StringIO.new": "StringIO", "Tempfile.new": "Tempfile", "Tempfile.open": "Tempfile",
};

// Collect type-bearing assignments (`name = Const.new(...)` or a known factory) — the receiver-type
// evidence for pinning a later `name.method(...)`. Locals + @ivars; cross-method ivars (assigned in
// `initialize`, used elsewhere) are caught because the whole file's root is walked.
export function inferAssignments(text: string, root: any): RubyAssign[] {
  const out: RubyAssign[] = [];
  const visit = (n: any) => {
    if (n.type === "assignment") {
      const left = field(n, "left"), right = field(n, "right");
      if (left && right && right.type === "call" && (left.type === "identifier" || left.type === "instance_variable")) {
        const recvConst = constName(field(right, "receiver"));
        const m = field(right, "method")?.text;
        const fqn = m === "new" ? recvConst : (recvConst && m ? _FACTORY[`${recvConst}.${m}`] ?? null : null);
        if (fqn) out.push({ name: left.text, fqn, line: _row(n) });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
  };
  visit(root);
  return out;
}

// Resolve a constant name written in a given nesting to an indexed FQN (lexical lookup: nesting outward,
// then top-level). Returns the FQN key present in the index, or null.
function _resolveConst(index: RubyIndex, name: string, nesting: string[]): string | null {
  for (let k = nesting.length; k >= 0; k--) {
    const cand = [...nesting.slice(0, k), name].join("::");
    if (index.has(cand)) return cand;
  }
  return index.has(name) ? name : null;
}

// Ancestor-chain lookup: own methods → includes/prepends (instance) / extends (class) → superclass, recursively.
// Approximate MRO (no exact prepend precedence — we union for the sink-reaching goal). Returns the first hit.
function _lookup(index: RubyIndex, fqn: string, method: string, kind: MethodKind, seen: Set<string>): MethodCandidate | null {
  if (seen.has(fqn) || seen.size > 64) return null;
  seen.add(fqn);
  const info = index.get(fqn);
  if (!info) return null;
  const own = info.methods.get(method);
  if (own && own.kind === kind) return { className: fqn, method, file: own.file, line: own.line, kind, tier: "RESOLVED_FULL" };
  const mixinModes = kind === "instance" ? ["include", "prepend"] : ["extend"];
  for (const mx of info.mixins) {
    if (!mixinModes.includes(mx.mode)) continue;
    const mfqn = _resolveConst(index, mx.name, info.nesting);
    // a mixed-in module's methods are INSTANCE methods of the module; look them up as instance regardless
    const hit = mfqn ? _lookup(index, mfqn, method, "instance", seen) : null;
    if (hit) return { ...hit, tier: "RESOLVED_FULL" };
  }
  if (info.superclass) { const sfqn = _resolveConst(index, info.superclass, info.nesting); const hit = sfqn ? _lookup(index, sfqn, method, kind, seen) : null; if (hit) return hit; }
  // implicit Object: every class without an explicit superclass inherits Object, whose (private) instance
  // methods are the repo's TOP-LEVEL `def`s — so a top-level helper called from inside a class resolves.
  if (kind === "instance" && !info.superclass && fqn !== _TOPLEVEL && fqn !== "BasicObject") {
    const hit = _lookup(index, _TOPLEVEL, method, "instance", seen);
    if (hit) return hit;
  }
  return null;
}

// A receiver-less (self) call inside `className`'s body → its instance-method def via the ancestor chain.
export function resolveSelfCall(index: RubyIndex, className: string, method: string): MethodCandidate[] {
  const hit = _lookup(index, className, method, "instance", new Set());
  return hit ? [hit] : [];
}

// All defs of `method` across the index — the over-approximation used when the receiver type is unknown.
function _byName(index: RubyIndex, method: string, tier: Provenance): MethodCandidate[] {
  const out: MethodCandidate[] = [];
  for (const info of index.values()) { const d = info.methods.get(method); if (d) out.push({ className: info.fqn, method, file: d.file, line: d.line, kind: d.kind, tier }); }
  return out;
}

// Resolve `recvExpr.method(...)` at line `atLine` to method-definition candidate(s), tiered by provenance.
//  - receiver is a Constant (`Foo` / `Foo::Bar`)  → class-method lookup on that type (PINNED) → RESOLVED_FULL
//  - receiver is a local/@ivar assigned `= C.new` → instance lookup on C (PINNED) → RESOLVED_FULL
//  - receiver type unknown                        → the method's defs repo-wide: 1 ⇒ RESOLVED_PARTIAL, N ⇒ SUGGESTED
export function resolveMethodCall(
  index: RubyIndex, recvExpr: string, method: string, assigns: RubyAssign[], atLine: number, nesting: string[] = [],
): MethodCandidate[] {
  // PINNED via constant receiver → class-method call.
  if (/^[A-Z]/.test(recvExpr) || recvExpr.includes("::")) {
    const fqn = _resolveConst(index, recvExpr, nesting);
    if (fqn) { const hit = _lookup(index, fqn, method, "class", new Set()); if (hit) return [hit]; }
  } else {
    // PINNED via the nearest preceding `recvExpr = Const.new` (last assignment before the call).
    const a = assigns.filter((x) => x.name === recvExpr && x.line <= atLine).sort((p, q) => q.line - p.line)[0];
    if (a) { const fqn = _resolveConst(index, a.fqn, nesting); if (fqn) { const hit = _lookup(index, fqn, method, "instance", new Set()); if (hit) return [hit]; } }
  }
  // UNKNOWN receiver type → over-approximate by method name, tiered by candidate count (quarantined behind the tier).
  const all = _byName(index, method, "SUGGESTED");
  if (all.length === 1) return [{ ...all[0], tier: "RESOLVED_PARTIAL" }];
  return all;
}
