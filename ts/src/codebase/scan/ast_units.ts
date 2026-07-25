// SCAN phase — shared AST-unit helpers: read a repo file, enumerate the named defs ("units") in a parse,
// and locate the enclosing unit / usage lines of a symbol. The deterministic substrate every footprint
// builder sits on. Cross-language via the node-kind SETS in ../atoms (no raw literals here).
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Ctx, lang_for,
  _FUNCLIKE, _ANON_FUNC, _METHOD_KINDS, _CLASS_KINDS, _VAR_DECLARATOR, _NAME_KINDS, _NAME_LEAVES, _CALL, _EXPORT, _VAR_DECL,
  _EXPORT_CLAUSE, _EXPORT_SPECIFIER, _EXPORT_DEFAULT, _MEMBER, _MEMBER_NAME,
} from "../atoms.js";
import { provider_for } from "../../core/resolve/languages/index.js";
import { recordRead } from "../../core/resolve/dep_recorder.js";
import type { Unit } from "./graph.js";

export const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);
export const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

// Read a repo-relative source file + its language; null when the path isn't a known source language or the
// read fails. The single I/O choke point the builders share.
export function _read(repo: string, rel: string): [string, string] | null {
  const lang = lang_for(rel);
  if (!lang) return null;
  try { const content = readFileSync(join(repo, rel), "utf-8"); recordRead(rel, content); return [content, lang]; } catch { return null; }
}

export function _name_of(ctx: Ctx, node: any): string | null {
  // (1) the tree-sitter `name` FIELD — the declared name, NOT a leading return type. A positional scan
  // grabs the wrong child on every typed language that writes the type first: Java/C++ `Booking
  // createBooking(...)` → the return type's `type_identifier` precedes the method `identifier`, so the
  // old scan returned "Booking". The field is exact across grammars (method/class/function `name`).
  const nf = node.childForFieldName?.("name");
  if (nf) return ctx.text(nf);
  // (2) C/C++ have NO `name` field — the name is buried in the `declarator` field chain (function_definition
  // → function_declarator → … → identifier). Follow ONLY that field (never `parameters`, or a param name is
  // mistaken for the function). Mirrors def_treesitter._declaratorName.
  let x: any = node.childForFieldName?.("declarator");
  for (let g = 0; x && g < 16; g++) {
    if (_NAME_LEAVES.has(x.type)) return ctx.text(x);
    x = x.childForFieldName?.("declarator") ?? null;
  }
  // (3) positional fallback — grammars without a `name` field / anonymous-ish nodes.
  for (const c of ctx.children(node)) if (_NAME_KINDS.has(c.type)) return ctx.text(c);
  return null;
}

// Every named function/method/class/assigned-function def in the parse, as [name, kind, start, end].
// Memo the full-tree unit scan by Ctx identity. `makeCtx` returns the SAME Ctx instance for the same (content,
// grammar) — its own LRU cache — so a file examined more than once in a grow (as a consumer in one build, a
// candidate / dependency in another) re-traverses its whole tree each time. After the inverted indices, this
// per-neighbour re-traversal is a chunk of the residual UP/DOWN cost. WeakMap → entries vanish when the Ctx is
// evicted from the parse cache and GC'd, so it's bounded with no manual eviction. Pure (content-determined).
const _namedUnitsMemo = new WeakMap<Ctx, Unit[]>();
export function _named_units(ctx: Ctx): Unit[] {
  const cached = _namedUnitsMemo.get(ctx);
  if (cached) return cached;
  const units: Unit[] = [];
  // `inClass` = this node sits DIRECTLY in a class body (not nested inside a function). A funclike there is a
  // METHOD even when its node kind isn't in _METHOD_KINDS — Ruby `def` parses as `method`, a C++ in-class body
  // as `function_definition`; both are otherwise mislabelled "function", which skips the receiver-agnostic
  // call-site pass (methods are called `obj.m()`, never imported, so the import scan can't find their callers).
  const visit = (n: any, inClass: boolean) => {
    const k = n.type;
    if (_FUNCLIKE.has(k) && !_ANON_FUNC.has(k)) {
      const nm = _name_of(ctx, n);
      if (nm) { const [s, e] = ctx.span(n); units.push([nm, (_METHOD_KINDS.has(k) || inClass) ? "method" : "function", s, e]); }
    } else if (_CLASS_KINDS.has(k)) {
      const nm = _name_of(ctx, n);
      if (nm) { const [s, e] = ctx.span(n); units.push([nm, "class", s, e]); }
    } else if (_VAR_DECLARATOR.has(k)) {
      const ch = ctx.children(n);
      const fl = ch.find((c) => _FUNCLIKE.has(c.type));
      if (fl && ch.length && _NAME_KINDS.has(ch[0].type)) { const [s, e] = ctx.span(fl); units.push([ctx.text(ch[0]), "function", s, e]); }
    }
    // descend: a class body makes its children in-class; entering a funclike resets (a nested local function's
    // own children are NOT class methods); otherwise carry the flag through intermediate nodes (the class body).
    const childInClass = _CLASS_KINDS.has(k) ? true : (_FUNCLIKE.has(k) ? false : inClass);
    for (const c of ctx.children(n)) visit(c, childInClass);
  };
  visit(ctx.root, false);
  _namedUnitsMemo.set(ctx, units);
  return units;
}

// A `const NAME = wrapper(realFn, …)` HOC / reporting wrapper (React memo/forwardRef, a sentry `withReporting`
// wrapper, …): the const's VALUE is a CALL, not a funclike, so `_named_units` doesn't see NAME as a def and a
// `--center #NAME` anchor binds to :0 with NO body (the real logic is the WRAPPED function). The impl is the
// call's FUNCTION argument — an inline arrow/function, or an identifier naming a same-file function. Resolve NAME
// to THAT span so the anchor gets the real body (cal.com `scheduleWorkflowReminders = withReporting(_scheduleWorkflowReminders)`
// → the `_scheduleWorkflowReminders` impl). Anchor-scoped (not folded into `_named_units`) → zero repo-wide ripple.
// Returns [start,end] of the impl, or the declarator span for an external wrapped fn (a real span beats :0), else null.
export function _wrappedDefSpan(ctx: Ctx, symbol: string, units: Unit[]): [number, number] | null {
  for (const d of ctx.collect(ctx.root, (k) => _VAR_DECLARATOR.has(k))) {
    const ch = ctx.children(d);
    if (!ch.length || !_NAME_KINDS.has(ch[0].type) || ctx.text(ch[0]) !== symbol) continue;
    const call = ch.find((c) => _CALL.has(c.type));
    if (!call) continue;   // `const X = <non-call>` (a value/config) — not a wrapped def
    const w = _wrappedImpl(ctx, call, units);
    if (w) return w.inline ? ctx.span(w.node) : [w.unit![2], w.unit![3]];
    return ctx.span(d);                                                        // wrapped external fn → the declarator span (a real span, not :0)
  }
  return null;
}

// THE wrapper-unwrapping RULE, in one place: given a wrapper CALL node, which of its arguments is the real
// implementation? An inline funclike argument IS the body (`memo(() => {…})`); otherwise the FIRST identifier
// argument that names a function/method unit of this same file (`withReporting(_impl, "name")`). A nested
// wrapper (`withReporting(withCache(fn))`) descends into the argument call. Returns the inline node OR the
// named unit, else null (opaque — an externally-defined wrapped fn, an unnameable expression). Shared by the
// span resolution above and by `_default_export_local` below, so both read a wrapper the SAME way.
function _wrappedImpl(ctx: Ctx, call: any, units: Unit[], depth = 0): { inline: boolean; node?: any; unit?: Unit } | null {
  if (depth > 4) return null;   // runaway guard on `a(b(c(d(…))))`
  const argsNode = call.childForFieldName?.("arguments") ?? ctx.children(call).find((c: any) => /arguments|argument_list/.test(c.type));
  const args: any[] = argsNode ? ctx.children(argsNode) : ctx.children(call).slice(1);
  const inlineFn = args.find((a) => _FUNCLIKE.has(a.type));
  if (inlineFn) return { inline: true, node: inlineFn };
  for (const a of args) if (a.type.includes("identifier")) {
    const u = units.find((x) => x[0] === ctx.text(a) && (x[1] === "function" || x[1] === "method"));
    if (u) return { inline: false, unit: u };
  }
  for (const a of args) if (_CALL.has(a.type)) { const inner = _wrappedImpl(ctx, a, units, depth + 1); if (inner) return inner; }
  return null;
}

// ADDRESSING — every name this file BINDS or DECLARES, i.e. the closed set of symbols a `<file>#<symbol>`
// address can legitimately name. Deliberately GENEROUS (a superset of the units the footprint builders anchor
// on): the question it answers is not "can we build a rich anchor node for this?" but "does this file mention
// this name as a DECLARATION at all?" — so a value const (`export const dynamicEvent = {…}`, a real anchor with
// real consumers), a type alias, a non-exported local or a re-export specifier all count. Only a name the file
// NEVER binds — the importer's local alias for a default export, a typo, a name that lives in another file — is
// absent, and that is an ADDRESSING error, never an empty result.
//   • _named_units       — functions / methods / classes / interfaces / enums
//   • _exported_members  — the public surface (adds value consts + barrel re-exports; exportless languages too)
//   • _VAR_DECLARATOR    — every binder, exported or not
//   • the `name` FIELD of any non-CALL node — type aliases, namespaces, Ruby modules, … (calls are excluded
//     because Java's method_invocation/Ruby's call carry a `name`/`method` field too, and a name that is only
//     CALLED here is not declared here)
//   • _EXPORT_SPECIFIER  — both sides of `export { local as exported }`
export function _declared_names(ctx: Ctx, file?: string): Set<string> {
  const out = new Set<string>();
  for (const u of _named_units(ctx)) out.add(u[0]);
  for (const m of _exported_members(ctx, file)) out.add(m[0]);
  for (const n of ctx.collect(ctx.root, () => true)) {
    const k = n.type;
    if (!_CALL.has(k)) {
      const nf = n.childForFieldName?.("name");
      if (nf && (_NAME_KINDS.has(nf.type) || _NAME_LEAVES.has(nf.type))) out.add(ctx.text(nf));
    }
    if (_VAR_DECLARATOR.has(k)) { const ch = ctx.children(n); if (ch.length && _NAME_KINDS.has(ch[0].type)) out.add(ctx.text(ch[0])); }
    if (_EXPORT_SPECIFIER.has(k)) for (const c of ctx.children(n)) if (_NAME_KINDS.has(c.type)) out.add(ctx.text(c));
  }
  out.delete("default");   // the `default` in `export { x as default }` is the BOUNDARY name, not a declared symbol
  return out;
}

// The LOCAL symbol behind this file's `export default` — the missing piece of the most common addressing
// mistake. Importers bind a default export under a name of THEIR choosing (`import handleCancelBooking from
// "…/handleCancelBooking"`), so the name a caller sees at the call sites is NOT a symbol of the defining file;
// the file's own name for it is. Structural: the `default` keyword node marks the export, and the local is the
// exported declaration's name (`export default function handler`), the exported identifier (`export default
// handler`), or the local side of `export { handler as default }`. Anonymous (`export default () => …`) → null,
// there is no local name to point at.
// (`export default withReporting(handler, "handler")` — a HOC / reporting WRAPPER call — fills the slot with the
// RESULT of wrapping a local; the local behind it is found with the SAME `_wrappedImpl` rule as `_wrappedDefSpan`.)
export function _default_export_local(ctx: Ctx, units?: Unit[]): string | null {
  for (const es of ctx.collect(ctx.root, (k) => _EXPORT.has(k))) {
    const kids = ctx.children(es);
    if (!kids.some((c) => _EXPORT_DEFAULT.has(c.type))) {
      // `export { handler as default }` — no `default` keyword on the statement; the specifier carries it.
      for (const cl of kids) {
        if (!_EXPORT_CLAUSE.has(cl.type)) continue;
        for (const sp of ctx.children(cl)) {
          if (!_EXPORT_SPECIFIER.has(sp.type)) continue;
          const names = ctx.children(sp).filter((c) => _NAME_KINDS.has(c.type));
          if (names.length >= 2 && ctx.text(names[names.length - 1]) === "default") return ctx.text(names[0]);
        }
      }
      continue;
    }
    for (const c of kids) {
      if (_EXPORT_DEFAULT.has(c.type)) continue;
      if ((_FUNCLIKE.has(c.type) && !_ANON_FUNC.has(c.type)) || _CLASS_KINDS.has(c.type)) { const nm = _name_of(ctx, c); if (nm) return nm; }
      else if (_NAME_KINDS.has(c.type)) return ctx.text(c);
      else if (_CALL.has(c.type)) {
        const w = _wrappedImpl(ctx, c, units ?? _named_units(ctx));
        if (w && !w.inline) return w.unit![0];   // inline arrow ⇒ anonymous, no local name to point at
      }
    }
  }
  return null;
}

// The smallest unit that encloses `line` (the tightest def around a usage), or null.
export function _enclosing(units: Unit[], line: number): Unit | null {
  const cands = units.filter((u) => u[2] <= line && line <= u[3]);
  return cands.length ? cands.reduce((a, b) => (b[3] - b[2] < a[3] - a[2] ? b : a)) : null;
}

// The name of the CLASS that owns the span [start,end] — the `enclosing` for a METHOD node (so a consumer
// reached mid-grow reads `AcmeCheckBookingsService.createBooking`, not a bare, ambiguous `createBooking`).
// Tightest containing class wins (nested classes); "" for a top-level function or a call in a class body whose
// own unit IS the class. STRUCTURAL (tree-sitter units), never a name heuristic.
export function _enclosingClass(units: Unit[], start: number, end: number): string {
  const cands = units.filter((u) => u[1] === "class" && u[2] <= start && end <= u[3] && !(u[2] === start && u[3] === end));
  return cands.length ? cands.reduce((a, b) => (b[3] - b[2] < a[3] - a[2] ? b : a))[0] : "";
}

export function _call_lines(ctx: Ctx, local: string): number[] {
  const lines: number[] = [];
  for (const c of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const ch = ctx.children(c);
    if (ch.length && ch[0].type.includes("identifier") && ctx.text(ch[0]) === local) lines.push(ctx.span(c)[0]);
  }
  return lines;
}

// METHOD-PRECISE INDEX — the SERIALIZABLE derivations the fan's method-precise rehydration needs (the reached
// method ranges + the file's bare-identifier call sites grouped by callee). Computed in ONE parse so the whole
// artifact can be DISK-CACHED per content-hash (see cachedMPIndex): a warm grow then skips the tree-sitter parse
// (`makeCtx`) that otherwise re-ran for every boundary file every run — the O(footprint) parse cost. `calls` is a
// superset of `_call_lines` (all callee names, not one), keyed for O(1) lookup during rehydration.
export type MPIndex = { units: Unit[]; calls: Record<string, number[]> };
export function methodPreciseIndex(ctx: Ctx): MPIndex {
  const units = _named_units(ctx);
  // NULL-PROTOTYPE: a callee named `toString`/`constructor`/`valueOf` would else read a truthy Object.prototype
  // member, so `??=` skips the array init and `.push` throws (real Java calls `toString()` everywhere). The read
  // side (rehydration) guards with Array.isArray for the same reason (a warm JSON.parse re-adds the prototype).
  const calls: Record<string, number[]> = Object.create(null);
  for (const c of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const ch = ctx.children(c);
    if (ch.length && ch[0].type.includes("identifier")) (calls[ctx.text(ch[0])] ??= []).push(ctx.span(c)[0]);
  }
  return { units, calls };
}

// The occurrences of `local`, split by whether the name is a MODULE-SCOPE binding use or a MEMBER access.
//  - BARE      — a plain name reference (`f`, `f(…)`): whatever binds `f` in this file (a def, an import) IS
//                what this occurrence means.
//  - QUALIFIED — the property side of a member access (`this.f`, `obj.f`): a member of some receiver, never
//                the file's module-scope binding.
// The distinction is what lets a caller drop a bare occurrence it can PROVE belongs to another binding while
// keeping the member calls on the anchor's own class. Structural, off the _MEMBER/_MEMBER_NAME kind registry
// (JS `member_expression`/`property_identifier`, Java `field_access`, C/C++ `field_expression`/`field_identifier`),
// never a literal grammar kind — so it degrades to "everything is bare" on a grammar with no member node,
// which is the conservative side.
export function _ref_lines_split(ctx: Ctx, local: string): { bare: number[]; qualified: number[] } {
  const bare = new Set<number>(), qualified = new Set<number>();
  for (const i of ctx.collect(ctx.root, (k) => k.includes("identifier"))) {
    if (ctx.text(i) !== local) continue;
    const p = (i as any).parent;
    const isProp = _MEMBER_NAME.has(i.type)
      || (p && _MEMBER.has(p.type) && ctx.children(p)[0]?.startIndex !== (i as any).startIndex);   // grammars with no distinct property kind
    (isProp ? qualified : bare).add(ctx.span(i)[0]);
  }
  return { bare: [...bare].sort((a, b) => a - b), qualified: [...qualified].sort((a, b) => a - b) };
}

export function _ref_lines(ctx: Ctx, local: string): number[] {
  const s = _ref_lines_split(ctx, local);
  return [...new Set([...s.bare, ...s.qualified])].sort((a, b) => a - b);
}

// The lines where `local` is USED: calls if any (the strongest signal), else references inside a unit,
// else all-but-the-first reference (drops the import/binding line).
export function _usage_lines(ctx: Ctx, units: Unit[], local: string): number[] {
  const calls = _call_lines(ctx, local);
  if (calls.length) return calls;
  const refs = _ref_lines(ctx, local);
  const inside = refs.filter((ln) => _enclosing(units, ln));
  return inside.length ? inside : refs.slice(1);
}

// The module's PUBLIC SURFACE, deduped by name. Feeds the module-anchor builder and the depth-2 ripple
// (only exported symbols ripple to their importers).
//
// A module boundary is expressed TWO structurally different ways, and reading only the first made the whole
// module shape (contract) return "no exported members" for most real files:
//  - EXPORT-STATEMENT languages (TS/JS): the boundary is the `export` node. Its child is a DECLARATION
//    (`export function f`) — or an export CLAUSE (`export { a } from "./x"`), the barrel/re-export form that
//    was previously skipped entirely, so an index.* that only re-exports looked empty.
//  - EXPORTLESS languages (Java/C/C++/Ruby/Python): there is no export node at all; visibility rides on
//    MODIFIERS, so the boundary is the file's TOP-LEVEL type declarations and their members. Asking these
//    files for `export_statement` found nothing, which is why EVERY Java/Ruby/C module reported no contract.
// `file` selects the reading via the language registry (`exportStatements`); omitted ⇒ export-statement
// reading only, preserving the original behaviour for callers that have no path.
export function _exported_members(ctx: Ctx, file?: string): Unit[] {
  const out: Unit[] = [];
  if (file && !provider_for(file)?.exportStatements) return _public_surface(ctx);
  for (const es of ctx.collect(ctx.root, (k) => _EXPORT.has(k))) {
    for (const ch of ctx.children(es)) {
      const k = ch.type;
      if (_FUNCLIKE.has(k) && !_ANON_FUNC.has(k)) { const nm = _name_of(ctx, ch); if (nm) { const [s, e] = ctx.span(ch); out.push([nm, "function", s, e]); } }
      else if (_CLASS_KINDS.has(k)) { const nm = _name_of(ctx, ch); if (nm) { const [s, e] = ctx.span(ch); out.push([nm, "class", s, e]); } }
      else if (_VAR_DECL.has(k)) {
        for (const d of ctx.children(ch)) {
          if (!_VAR_DECLARATOR.has(d.type)) continue;
          const dch = ctx.children(d);
          if (dch.length && _NAME_KINDS.has(dch[0].type)) {
            const isFn = dch.some((c) => _FUNCLIKE.has(c.type));
            const [s, e] = ctx.span(ch);
            out.push([ctx.text(dch[0]), isFn ? "function" : "constant", s, e]);
          }
        }
      }
      // RE-EXPORT / export-list: `export { a, b }` · `export { a as b } from "./x"`. The exported NAME is the
      // specifier's last name identifier (`a as b` exports `b`); the local alias is irrelevant at the boundary.
      else if (_EXPORT_CLAUSE.has(k)) {
        for (const sp of ctx.children(ch)) {
          if (!_EXPORT_SPECIFIER.has(sp.type)) continue;
          const names = ctx.children(sp).filter((c) => _NAME_KINDS.has(c.type));
          if (!names.length) continue;
          const [s, e] = ctx.span(sp);
          out.push([ctx.text(names[names.length - 1]), "reference", s, e]);
        }
      }
    }
  }
  // THE DEFAULT SLOT IS PUBLIC SURFACE TOO. `export default handler` / `export default withReporting(handler,
  // "handler")` puts a declaration on the module boundary WITHOUT naming it in any declaration or specifier the
  // loop above reads — its child is a bare identifier or a CALL. So a module whose entire public API is its
  // default export reported ZERO exported members, hence `fan-in: 0 consuming files` for a module with real
  // importers (cal.com packages/features/schedules/lib/slots.ts, whose 3 default importers were invisible).
  // Grounded, not name-matched: the local must be a DECLARED unit of this file (that's where the span comes
  // from); an anonymous `export default () => …` or an opaque wrapper adds nothing. No double count — a default
  // whose local is ALSO a named export (`export const prisma` + `export default prisma`) dedupes below.
  const dunits = _named_units(ctx);
  const dflt = _default_export_local(ctx, dunits);
  const du = dflt ? dunits.find((u) => u[0] === dflt) : undefined;
  if (dflt && du) out.push([dflt, du[1], du[2], du[3]]);
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m[0]) ? false : (seen.add(m[0]), true)));
}

// The public surface of an EXPORTLESS language: top-level type declarations (class/interface/enum/record/
// struct) plus the members declared directly in their bodies, and top-level free functions (C/C++/Ruby).
// Nested/local functions are NOT surface — descent stops at a function body, exactly as _named_units does.
function _public_surface(ctx: Ctx): Unit[] {
  const out: Unit[] = [];
  const visit = (n: any, depth: number) => {
    const k = n.type;
    if (_CLASS_KINDS.has(k)) {
      const nm = _name_of(ctx, n);
      if (nm) { const [s, e] = ctx.span(n); out.push([nm, "class", s, e]); }
    } else if (_FUNCLIKE.has(k) && !_ANON_FUNC.has(k)) {
      const nm = _name_of(ctx, n);
      if (nm) { const [s, e] = ctx.span(n); out.push([nm, _METHOD_KINDS.has(k) || depth > 0 ? "method" : "function", s, e]); }
      return;                                     // a function body holds locals, not surface
    }
    for (const c of ctx.children(n)) visit(c, _CLASS_KINDS.has(k) ? depth + 1 : depth);
  };
  visit(ctx.root, 0);
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m[0]) ? false : (seen.add(m[0]), true)));
}
