// SCAN phase — shared AST-unit helpers: read a repo file, enumerate the named defs ("units") in a parse,
// and locate the enclosing unit / usage lines of a symbol. The deterministic substrate every footprint
// builder sits on. Cross-language via the node-kind SETS in ../atoms (no raw literals here).
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Ctx, lang_for,
  _FUNCLIKE, _ANON_FUNC, _METHOD_KINDS, _CLASS_KINDS, _VAR_DECLARATOR, _NAME_KINDS, _NAME_LEAVES, _CALL, _EXPORT, _VAR_DECL,
} from "../atoms.js";
import type { Unit } from "./graph.js";

export const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);
export const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

// Read a repo-relative source file + its language; null when the path isn't a known source language or the
// read fails. The single I/O choke point the builders share.
export function _read(repo: string, rel: string): [string, string] | null {
  const lang = lang_for(rel);
  if (!lang) return null;
  try { return [readFileSync(join(repo, rel), "utf-8"), lang]; } catch { return null; }
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
    const argsNode = (call as any).childForFieldName?.("arguments") ?? ctx.children(call).find((c: any) => /arguments|argument_list/.test(c.type));
    const args: any[] = argsNode ? ctx.children(argsNode) : ctx.children(call).slice(1);
    const inlineFn = args.find((a) => _FUNCLIKE.has(a.type));
    if (inlineFn) return ctx.span(inlineFn);                                   // `memo(() => {…})` — the arrow IS the body
    for (const a of args) if (a.type.includes("identifier")) {                 // `withReporting(_impl, "name")` — the impl is the named fn
      const u = units.find((x) => x[0] === ctx.text(a) && (x[1] === "function" || x[1] === "method"));
      if (u) return [u[2], u[3]];
    }
    return ctx.span(d);                                                        // wrapped external fn → the declarator span (a real span, not :0)
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

export function _ref_lines(ctx: Ctx, local: string): number[] {
  return [...new Set(ctx.collect(ctx.root, (k) => k.includes("identifier")).filter((i) => ctx.text(i) === local).map((i) => ctx.span(i)[0]))].sort((a, b) => a - b);
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

// The module's EXPORTED members (functions/classes/exported var declarations), deduped by name. Feeds the
// module-anchor builder and the depth-2 ripple (only exported symbols ripple to their importers).
export function _exported_members(ctx: Ctx): Unit[] {
  const out: Unit[] = [];
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
    }
  }
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m[0]) ? false : (seen.add(m[0]), true)));
}
