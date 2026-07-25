// SCAN phase — class/instance AST queries used by the class & call-site footprint builders: a class's
// methods, the instances of a class, which methods a file calls on them, and the inheritance relation
// used to narrow a method call's receiver to a subclass family. Cross-language via ../atoms node SETS.
import {
  type Ctx,
  _CLASS_KINDS, _METHOD_KINDS, _MEMBER, _MEMBER_NAME, _NEW, _INSTANCE_BINDER, _TYPE_REF,
  _INTERFACE, _INTERFACE_MEMBER, _HERITAGE, _BASE_NAME, _NAME_KINDS, _CALL, _CALL_NAME_FIELD, _CALL_RECV_FIELD,
  _CLASS_FIELD,
} from "../atoms.js";
import { type Unit } from "./graph.js";
import { _name_of, _enclosingClass } from "./ast_units.js";

// The class that OWNS a FIELD-bound function member named `symbol` (`m = withReporting(this._m.bind(this))`,
// `m = (x) => …`). Such a member is dispatched exactly like a method (`instance.m()`) but is NOT a
// method_definition, so `_named_units` yields no unit for it — leaving the call-site pass with an EMPTY owner.
// An empty owner disables `family` / `provablyForeign` / `provablySibling` / `staticForeign` wholesale, so the
// pass degenerates to a repo-wide NAME match and every same-named method on an unrelated class is asserted as a
// verified caller. Recovering the owner here is what re-arms receiver grounding for this anchor shape.
// Grounded on the parse tree (the field's span inside the class's span), never on a name convention.
export function _field_fn_owner(ctx: Ctx, symbol: string, units: Unit[]): string {
  for (const f of ctx.collect(ctx.root, (k) => _CLASS_FIELD.has(k))) {
    if (_name_of(ctx, f) !== symbol) continue;
    const [s, e] = ctx.span(f);
    const owner = _enclosingClass(units, s, e);
    if (owner) return owner;
  }
  return "";
}

// The (method name + its node + receiver) of a call site, across the two call-grammar shapes. NESTED
// (JS/TS/Python/C++): the callee is a member node `obj.prop`. FLAT (Java/Ruby/C#): `name`/`object` are
// direct FIELDS of the call node, no member node — so the nested branch skips every Java/Ruby method call,
// and dispatching on the first child is unreliable (a `this.x.m()` receiver is itself a member node). Read
// the flat name field FIRST (definitive — nested grammars have none). `obj` is null for an unqualified call.
function _callee(ctx: Ctx, call: any): { nameNode: any; name: string; obj: any | null } | null {
  for (const nf of _CALL_NAME_FIELD) {
    const n = call.childForFieldName?.(nf);
    if (n) {
      let obj: any = null;
      for (const of of _CALL_RECV_FIELD) { const o = call.childForFieldName?.(of); if (o) { obj = o; break; } }
      return { nameNode: n, name: ctx.text(n), obj };
    }
  }
  const fn = ctx.children(call)[0] ?? null;
  if (fn && _MEMBER.has(fn.type)) {
    const mch = ctx.children(fn);
    const prop = mch.find((c) => _MEMBER_NAME.has(c.type)) ?? null;
    if (prop) return { nameNode: prop, name: ctx.text(prop), obj: mch[0] ?? null };
  }
  // UNQUALIFIED call — a bare `foo(...)` whose callee is a direct identifier (JS/TS `call_expression`, where the
  // callee is the `function` field, not `name`/`method`). No receiver. Without this the call-spine signal misses
  // every plain function call in JS/TS (a free `formatOrders(...)` reads as a payload type, not a delegation).
  if (fn && _NAME_KINDS.has(fn.type)) return { nameNode: fn, name: ctx.text(fn), obj: null };
  return null;
}

// The methods declared on class `className` (excluding the constructor), deduped → [name, start, end].
export function _class_methods(ctx: Ctx, className: string): [string, number, number][] {
  const cls = ctx.collect(ctx.root, (k) => _CLASS_KINDS.has(k)).find((c) => _name_of(ctx, c) === className);
  if (!cls) return [];
  const out: [string, number, number][] = [];
  for (const m of ctx.collect(cls, (k) => _METHOD_KINDS.has(k) && k !== "constructor_declaration")) {
    const nm = _name_of(ctx, m);   // the tree-sitter `name` FIELD — Java method names are `identifier`, which
    if (nm && nm !== "constructor") { const [s, e] = ctx.span(m); out.push([nm, s, e]); }   // `_MEMBER_NAME` (property_identifier) missed entirely
  }
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x[0]) ? false : (seen.add(x[0]), true)));
}

export function _is_new_of(ctx: Ctx, node: any, className: string): boolean {
  if (!_NEW.has(node.type)) return false;
  const cons = ctx.children(node).find((c) => c.type === "identifier" || _MEMBER.has(c.type));
  return !!cons && ctx.text(cons) === className;
}

// The declared type NAMES of a binder. Types written INSIDE the binder (TS `x: C`, an `= new C()` initializer,
// generics) PLUS the type on the binder's PARENT declaration — Java/C++ write the type on the field_declaration
// / local_variable_declaration, NOT inside the variable_declarator, so a bare `BookingRepo repo;` (the @Inject
// bean — the central delegation target) is otherwise invisible. Parent's `type` field, cross-language.
function _binderTypes(ctx: Ctx, binder: any): string[] {
  const out = ctx.collect(binder, (k) => _TYPE_REF.has(k)).map((t) => ctx.text(t));
  const tf = binder.parent?.childForFieldName?.("type");
  if (tf) for (const t of (_TYPE_REF.has(tf.type) ? [tf] : ctx.collect(tf, (k) => _TYPE_REF.has(k)))) out.push(ctx.text(t));
  return out;
}

// The local names bound to an instance of `className` (typed `x: C` / `C x` / `x = new C()`).
export function _instances_of(ctx: Ctx, className: string): Set<string> {
  const names = new Set<string>();
  for (const node of ctx.collect(ctx.root, (k) => _INSTANCE_BINDER.has(k))) {
    const nameNode = ctx.children(node).find((c) => _NAME_KINDS.has(c.type));
    if (!nameNode) continue;
    const typed = _binderTypes(ctx, node).includes(className);
    const newed = ctx.collect(node, (k) => _NEW.has(k)).some((nx) => _is_new_of(ctx, nx, className));
    if (typed || newed) names.add(ctx.text(nameNode));
  }
  return names;
}

// {method → first call line} for methods of `className` called on a provable instance of it.
export function _class_method_usage(ctx: Ctx, className: string, methods: Set<string>): Record<string, number> {
  const inst = _instances_of(ctx, className);
  const used: Record<string, number> = {};
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const c = _callee(ctx, call);
    if (!c || !c.obj || !methods.has(c.name)) continue;
    const obj = c.obj, m = c.name;
    let hit = false;
    if (obj.type === "identifier" && inst.has(ctx.text(obj))) hit = true;
    else if (_NEW.has(obj.type) && _is_new_of(ctx, obj, className)) hit = true;
    else if (_MEMBER.has(obj.type)) {
      const ip = ctx.children(obj).find((c) => _MEMBER_NAME.has(c.type));
      if (ip && inst.has(ctx.text(ip))) hit = true;
    }
    if (hit && !(m in used)) used[m] = ctx.span(call)[0];
  }
  return used;
}

// Every call site of one of `methods` (receiver-agnostic) → [method, line, col]. The LSP-candidate input.
export function _class_call_sites(ctx: Ctx, methods: Set<string>): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const c = _callee(ctx, call);   // receiver-agnostic: name is enough (no `obj` requirement)
    if (c && methods.has(c.name)) out.push([c.name, ctx.span(c.nameNode)[0], ctx.col(c.nameNode.startIndex)]);
  }
  return out;
}

// The methods of a class OR interface `name` (falls back to interface members when it's not a class).
export function _type_methods(ctx: Ctx, name: string): [string, number, number][] {
  const cm = _class_methods(ctx, name);
  if (cm.length) return cm;
  const iface = ctx.collect(ctx.root, (k) => _INTERFACE.has(k)).find((c) => _name_of(ctx, c) === name) ?? null;
  if (!iface) return [];
  const out: [string, number, number][] = [];
  for (const m of ctx.collect(iface, (k) => _INTERFACE_MEMBER.has(k))) {
    const nm = _name_of(ctx, m);   // field-based — Java interface method names are `identifier`, not property_identifier
    if (nm) { const [s, e] = ctx.span(m); out.push([nm, s, e]); }
  }
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x[0]) ? false : (seen.add(x[0]), true)));
}

// Direct `extends` bases of every class in a file → [class, bases]. Reads only the DIRECT name
// children of the heritage clause, so a base's generic args (`extends Engine<Run>` → Engine, not Run)
// and an `implements` clause are excluded. Feeds the repo-wide inheritance map for narrowing.
export function _class_bases(ctx: Ctx): [string, string[]][] {
  const out: [string, string[]][] = [];
  const namesOf = (clause: any) => ctx.children(clause).filter((c) => _BASE_NAME.has(c.type)).map((c) => ctx.text(c));
  for (const cls of ctx.collect(ctx.root, (k) => _CLASS_KINDS.has(k))) {
    const name = _name_of(ctx, cls);
    if (!name) continue;
    const bases: string[] = [];
    // The extends clause is a direct child (Python argument_list, Java superclass) OR nested one level
    // under a `class_heritage` wrapper (TS), which also holds `implements` — only the extends clause is
    // in _HERITAGE, so implemented interfaces and a base's generic args are excluded.
    for (const h of ctx.children(cls)) {
      if (_HERITAGE.has(h.type)) bases.push(...namesOf(h));
      else if (h.type === "class_heritage") for (const ec of ctx.children(h).filter((c) => _HERITAGE.has(c.type))) bases.push(...namesOf(ec));
    }
    out.push([name, bases]);
  }
  return out;
}

// Per-file map of instance binder → the class names it could hold (type annotation OR `new X()`).
// Generalises _instances_of (which filters by one class) to capture the type NAME, so a call site's
// receiver can be checked against a whole subclass family. Covers vars, params, and class fields.
const _instTypesCache = new WeakMap<Ctx, Map<string, Set<string>>>();   // pure ctx→types; memoised (see _all_call_sites)
export function _instance_types(ctx: Ctx): Map<string, Set<string>> {
  const memo = _instTypesCache.get(ctx);
  if (memo) return memo;
  const out = new Map<string, Set<string>>();
  for (const node of ctx.collect(ctx.root, (k) => _INSTANCE_BINDER.has(k))) {
    const nameNode = ctx.children(node).find((c) => _NAME_KINDS.has(c.type));
    if (!nameNode) continue;
    const types = new Set<string>(_binderTypes(ctx, node));   // within + parent-declared (Java/C++ field/local type)
    for (const nx of ctx.collect(node, (k) => _NEW.has(k))) {
      const cons = ctx.children(nx).find((c) => c.type === "identifier" || _MEMBER.has(c.type));
      if (cons) types.add(ctx.text(cons));
    }
    if (types.size) { const cur = out.get(ctx.text(nameNode)) ?? new Set<string>(); for (const x of types) cur.add(x); out.set(ctx.text(nameNode), cur); }
  }
  _instTypesCache.set(ctx, out);
  return out;
}

// Call sites of one of `methods`, WITH receiver shape so narrowing can resolve the receiver's type:
// recvId = `x` in `x.m()` (or the trailing field of `this.x.m()`); recvNew = `X` in `new X().m()`.
type _CallSite = { method: string; line: number; recvId: string | null; recvNew: string | null };
// PER-Ctx memo of EVERY method call site (method-INDEPENDENT — the expensive `ctx.collect` AST walk). A grow's
// callsite pass calls _method_call_sites once PER candidate consumer PER up-move, and candidates overlap heavily
// across moves; the parse (makeCtx) is already cached so the same Ctx object recurs, but the site walk was
// recomputed every time (measured ~67s / 6195 calls of a cold cal.com grow). Compute all sites once per Ctx,
// then filter by the requested method set — byte-identical (same sites, same recv fields, filtered the same way).
const _allSitesCache = new WeakMap<Ctx, _CallSite[]>();
function _all_call_sites(ctx: Ctx): _CallSite[] {
  const memo = _allSitesCache.get(ctx);
  if (memo) return memo;
  const out: _CallSite[] = [];
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const c = _callee(ctx, call);
    if (!c || !c.obj) continue;
    const obj = c.obj, m = c.name;
    let recvId: string | null = null, recvNew: string | null = null;
    if (obj.type === "identifier") recvId = ctx.text(obj);
    else if (_NEW.has(obj.type)) { const c = ctx.children(obj).find((x) => x.type === "identifier" || _MEMBER.has(x.type)); recvNew = c ? ctx.text(c) : null; }
    else if (_MEMBER.has(obj.type)) { const ip = ctx.children(obj).find((c) => _MEMBER_NAME.has(c.type)); recvId = ip ? ctx.text(ip) : null; }
    // Ruby `Const.new.method()` — the receiver is itself a CALL node (Ruby has no `_NEW` kind; `.new` is an
    // ordinary call), so a `new` call on a Constant receiver IS an instantiation → recvNew = that constant.
    // Grounded (a constant receiver + the `new` factory method), so it promotes the provable direct-instance
    // case to FULL and lets provablyForeign drop an unrelated `Other.new.method()` name-collision. The bare
    // last segment matches the class-family index (keyed by class name). Only Ruby yields a call-as-receiver.
    else if (_CALL.has(obj.type)) {
      const mth = obj.childForFieldName?.(_CALL_NAME_FIELD.find((f) => obj.childForFieldName?.(f)) ?? "");
      const rcv = _CALL_RECV_FIELD.map((f) => obj.childForFieldName?.(f)).find(Boolean);
      if (mth && ctx.text(mth) === "new" && rcv && /^[A-Z]/.test(ctx.text(rcv))) recvNew = ctx.text(rcv).split("::").pop() ?? null;
    }
    out.push({ method: m, line: ctx.span(call)[0], recvId, recvNew });
  }
  _allSitesCache.set(ctx, out);
  return out;
}
export function _method_call_sites(ctx: Ctx, methods: Set<string>): _CallSite[] {
  return _all_call_sites(ctx).filter((s) => methods.has(s.method));   // filter the memoised all-sites walk by the requested methods
}

// The TYPE-name tokens referenced in a file — every identifier used in a TYPE position (`Optional<X>`, a
// cast, extends/implements) plus `new X()` constructors. Lets the call-site pass tell a STATIC receiver
// (`Optional.empty()` — the receiver IS a type) from an instance one, so a bare-name match to an unrelated
// class's same-named method (`empty`) is dropped: the call dispatches to that type, not the anchor. Grounded
// on structural type positions (a closed node-kind set), not a capitalisation/naming convention.
const _typeNamesCache = new WeakMap<Ctx, Set<string>>();   // pure ctx→type-names; memoised (see _all_call_sites)
export function _type_names(ctx: Ctx): Set<string> {
  const memo = _typeNamesCache.get(ctx);
  if (memo) return memo;
  const out = new Set<string>();
  for (const t of ctx.collect(ctx.root, (k) => _TYPE_REF.has(k))) out.add(ctx.text(t));
  for (const nx of ctx.collect(ctx.root, (k) => _NEW.has(k))) {
    const c = ctx.children(nx).find((x) => x.type === "identifier" || _MEMBER.has(x.type));
    if (c) out.add(ctx.text(c));
  }
  _typeNamesCache.set(ctx, out);
  return out;
}

// The distinct method-call names this file makes (`obj.name()` → name) — method calls only (has a receiver),
// mirroring _method_call_sites' filter. Feeds the inverted call-site index so a consumer scan finds caller
// files by lookup instead of re-walking + re-reading the whole repo per build.
export function _called_method_names(ctx: Ctx): string[] {
  const out = new Set<string>();
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) { const c = _callee(ctx, call); if (c && c.obj) out.add(c.name); }
  return [...out];
}

// The set of names this file DELEGATES to (a call spine), vs names it only references as a TYPE (the data
// model / payload): the receiver TYPE of every `x.m()` / `new X().m()` call (resolved via the instance-type
// map) UNION the callee of every unqualified `foo()` call. A same-package/imported type that NEVER appears
// here is a pure payload (a DTO returned/passed but not invoked) — the dependency walk demotes it so the
// budget follows the delegation spine (service → repo → entityManager), not the data-model type tree.
export function _called_types(ctx: Ctx): Set<string> {
  const out = new Set<string>();
  const instTypes = _instance_types(ctx);
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const c = _callee(ctx, call);
    if (!c) continue;
    if (!c.obj) { out.add(c.name); continue; }                                  // unqualified foo() → foo
    const obj = c.obj;
    if (obj.type === "identifier") { const ts = instTypes.get(ctx.text(obj)); if (ts) for (const t of ts) out.add(t); }
    else if (_NEW.has(obj.type)) { const cons = ctx.children(obj).find((x) => x.type === "identifier" || _MEMBER.has(x.type)); if (cons) out.add(ctx.text(cons)); }
    else if (_MEMBER.has(obj.type)) { const ip = ctx.children(obj).find((x) => _MEMBER_NAME.has(x.type)); if (ip) { const ts = instTypes.get(ctx.text(ip)); if (ts) for (const t of ts) out.add(t); } }
  }
  return out;
}

// Transitive closure of `owner` under "is extended by": owner + every class that (directly or via
// an intermediate) extends it. These are exactly the receiver types that dispatch to owner's method.
export function _subclass_family(bases: Map<string, string[]>, owner: string): Set<string> {
  const fam = new Set<string>([owner]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [cls, bs] of bases) if (!fam.has(cls) && bs.some((b) => fam.has(b))) { fam.add(cls); changed = true; }
  }
  return fam;
}
