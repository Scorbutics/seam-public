// SCAN phase — shared AST-unit helpers: read a repo file, enumerate the named defs ("units") in a parse,
// and locate the enclosing unit / usage lines of a symbol. The deterministic substrate every footprint
// builder sits on. Cross-language via the node-kind SETS in ../atoms (no raw literals here).
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Ctx, lang_for,
  _FUNCLIKE, _ANON_FUNC, _METHOD_KINDS, _CLASS_KINDS, _VAR_DECLARATOR, _NAME_KINDS, _CALL, _EXPORT, _VAR_DECL,
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
  for (const c of ctx.children(node)) if (_NAME_KINDS.has(c.type)) return ctx.text(c);
  return null;
}

// Every named function/method/class/assigned-function def in the parse, as [name, kind, start, end].
export function _named_units(ctx: Ctx): Unit[] {
  const units: Unit[] = [];
  const visit = (n: any) => {
    const k = n.type;
    if (_FUNCLIKE.has(k) && !_ANON_FUNC.has(k)) {
      const nm = _name_of(ctx, n);
      if (nm) { const [s, e] = ctx.span(n); units.push([nm, _METHOD_KINDS.has(k) ? "method" : "function", s, e]); }
    } else if (_CLASS_KINDS.has(k)) {
      const nm = _name_of(ctx, n);
      if (nm) { const [s, e] = ctx.span(n); units.push([nm, "class", s, e]); }
    } else if (_VAR_DECLARATOR.has(k)) {
      const ch = ctx.children(n);
      const fl = ch.find((c) => _FUNCLIKE.has(c.type));
      if (fl && ch.length && _NAME_KINDS.has(ch[0].type)) { const [s, e] = ctx.span(fl); units.push([ctx.text(ch[0]), "function", s, e]); }
    }
    for (const c of ctx.children(n)) visit(c);
  };
  visit(ctx.root);
  return units;
}

// The smallest unit that encloses `line` (the tightest def around a usage), or null.
export function _enclosing(units: Unit[], line: number): Unit | null {
  const cands = units.filter((u) => u[2] <= line && line <= u[3]);
  return cands.length ? cands.reduce((a, b) => (b[3] - b[2] < a[3] - a[2] ? b : a)) : null;
}

export function _call_lines(ctx: Ctx, local: string): number[] {
  const lines: number[] = [];
  for (const c of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const ch = ctx.children(c);
    if (ch.length && ch[0].type.includes("identifier") && ctx.text(ch[0]) === local) lines.push(ctx.span(c)[0]);
  }
  return lines;
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
