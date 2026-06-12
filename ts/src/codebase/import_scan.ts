// Port of src/codebase/import_scan.py — the deterministic import-scan FRONT: build a ResolvedGraph
// (the same contract the VS Code resolver emits) from a named-import scan. C4 slice: the single-
// symbol consumers graph (build_resolved_graph). Class / module / dependency / depth-2 paths land
// in later C4 slices. An edge is RESOLVED only when the import module resolves to the anchor file;
// an unresolved name match is a SUGGESTED blindspot (never a resolved edge).
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type Ctx, makeCtx, available, lang_for,
  _FUNCLIKE, _ANON_FUNC, _METHOD_KINDS, _CLASS_KINDS, _VAR_DECLARATOR, _NAME_KINDS, _CALL,
  _MEMBER, _MEMBER_NAME, _NEW, _INSTANCE_BINDER, _TYPE_REF, _INTERFACE,
} from "./atoms.js";
import { scan_consumers, _kind_for } from "../core/resolve/consumers.js";

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);
const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

type Unit = [string, string, number, number]; // name, kind, start, end

function _name_of(ctx: Ctx, node: any): string | null {
  for (const c of ctx.children(node)) if (_NAME_KINDS.has(c.type)) return ctx.text(c);
  return null;
}

function _named_units(ctx: Ctx): Unit[] {
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

function _enclosing(units: Unit[], line: number): Unit | null {
  const cands = units.filter((u) => u[2] <= line && line <= u[3]);
  return cands.length ? cands.reduce((a, b) => (b[3] - b[2] < a[3] - a[2] ? b : a)) : null;
}

function _call_lines(ctx: Ctx, local: string): number[] {
  const lines: number[] = [];
  for (const c of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const ch = ctx.children(c);
    if (ch.length && ch[0].type.includes("identifier") && ctx.text(ch[0]) === local) lines.push(ctx.span(c)[0]);
  }
  return lines;
}

function _ref_lines(ctx: Ctx, local: string): number[] {
  return [...new Set(ctx.collect(ctx.root, (k) => k.includes("identifier")).filter((i) => ctx.text(i) === local).map((i) => ctx.span(i)[0]))].sort((a, b) => a - b);
}

function _usage_lines(ctx: Ctx, units: Unit[], local: string): number[] {
  const calls = _call_lines(ctx, local);
  if (calls.length) return calls;
  const refs = _ref_lines(ctx, local);
  const inside = refs.filter((ln) => _enclosing(units, ln));
  return inside.length ? inside : refs.slice(1);
}

function _read(repo: string, rel: string): [string, string] | null {
  const lang = lang_for(rel);
  if (!lang) return null;
  try { return [readFileSync(join(repo, rel), "utf-8"), lang]; } catch { return null; }
}

export async function build_resolved_graph(repo: string, anchorFile: string, symbol: string,
    opts: { depth?: number; verified?: any; anchorLine?: number | null } = {}): Promise<any> {
  const depth = opts.depth ?? 1;
  repo = expanduser(repo);
  const nodes: any[] = [], edges: any[] = [], blindspots: any[] = [], unresolved: any[] = [];

  let arange = [0, 0];
  let akind = "symbol";
  const ar = _read(repo, anchorFile);
  if (ar && available()) {
    const ctx = await makeCtx(ar[0], ar[1]);
    if (ctx) {
      const defu = _named_units(ctx).find((u) => u[0] === symbol);
      if (defu) { akind = defu[1]; arange = [defu[2], defu[3]]; }
    }
  }
  if (opts.anchorLine != null) arange = [opts.anchorLine, Math.max(opts.anchorLine, arange[1])];
  if (akind === "class") return build_class_graph(repo, anchorFile, symbol, { depth, verified: opts.verified });
  nodes.push({ id: "n1", symbol, kind: akind, file: anchorFile, range: arange, enclosing: "", complexity: Math.max(1, arange[1] - arange[0] + 1) });

  let counter = 1;
  const seenKeys = new Map<string, string>();
  for (const con of scan_consumers(repo, anchorFile, symbol)) {
    if (con.status === "suggested") {
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
      nodes.push({ id: cid, symbol: name, kind: _kind_for(con.file, kind), file: con.file, range: [start, end], enclosing: cls, complexity: Math.max(1, end - start + 1) });
      edges.push({ from: cid, to: "n1", kind: "reference", provenance: "RESOLVED_FULL" });
    }
  }
  // depth-2 ripple lands in a later C4 slice.

  return {
    version: 1,
    anchor: { id: "n1", symbol, file: anchorFile, range: arange },
    language: lang_for(anchorFile) ?? "",
    resolutionQuality: "FULL", depth, complete: true,
    nodes, edges, blindspots, unresolved,
  };
}

// UP / consumers — for a plain function/class this is just build_resolved_graph; an INTERFACE also
// merges its method call-sites (the next slice). Port of build_consumers_graph.
export async function build_consumers_graph(repo: string, anchorFile: string, symbol: string,
    opts: { depth?: number; verified?: any; anchorLine?: number | null } = {}): Promise<any> {
  return build_resolved_graph(repo, anchorFile, symbol, opts);
}

// --------------------------------------------------------------------------- CLASS method attribution
function _class_methods(ctx: Ctx, className: string): [string, number, number][] {
  const cls = ctx.collect(ctx.root, (k) => _CLASS_KINDS.has(k)).find((c) => _name_of(ctx, c) === className);
  if (!cls) return [];
  const out: [string, number, number][] = [];
  for (const m of ctx.collect(cls, (k) => _METHOD_KINDS.has(k))) {
    const nameNode = ctx.children(m).find((c) => _MEMBER_NAME.has(c.type));
    const nm = nameNode ? ctx.text(nameNode) : null;
    if (nm && nm !== "constructor") { const [s, e] = ctx.span(m); out.push([nm, s, e]); }
  }
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x[0]) ? false : (seen.add(x[0]), true)));
}

function _is_new_of(ctx: Ctx, node: any, className: string): boolean {
  if (!_NEW.has(node.type)) return false;
  const cons = ctx.children(node).find((c) => c.type === "identifier" || _MEMBER.has(c.type));
  return !!cons && ctx.text(cons) === className;
}

function _instances_of(ctx: Ctx, className: string): Set<string> {
  const names = new Set<string>();
  for (const node of ctx.collect(ctx.root, (k) => _INSTANCE_BINDER.has(k))) {
    const nameNode = ctx.children(node).find((c) => _NAME_KINDS.has(c.type));
    if (!nameNode) continue;
    const typed = ctx.collect(node, (k) => _TYPE_REF.has(k)).some((t) => ctx.text(t) === className);
    const newed = ctx.collect(node, (k) => _NEW.has(k)).some((nx) => _is_new_of(ctx, nx, className));
    if (typed || newed) names.add(ctx.text(nameNode));
  }
  return names;
}

function _class_method_usage(ctx: Ctx, className: string, methods: Set<string>): Record<string, number> {
  const inst = _instances_of(ctx, className);
  const used: Record<string, number> = {};
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const ch = ctx.children(call);
    const fn = ch.length ? ch[0] : null;
    if (!fn || !_MEMBER.has(fn.type)) continue;
    const mch = ctx.children(fn);
    const obj = mch.length ? mch[0] : null;
    const prop = mch.find((c) => _MEMBER_NAME.has(c.type)) ?? null;
    if (!obj || !prop) continue;
    const m = ctx.text(prop);
    if (!methods.has(m)) continue;
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

export async function build_class_graph(repo: string, anchorFile: string, className: string,
    opts: { depth?: number; verified?: any } = {}): Promise<any> {
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

  const blindspots: any[] = [], unresolved: any[] = [];
  const pending: [string, string, string, number, number, Record<string, number>, string][] = [];
  const usedMethods = new Set<string>();
  for (const con of scan_consumers(repo, anchorFile, className)) {
    if (con.status === "suggested") {
      blindspots.push({ node: className, mechanism: "unresolved-import",
        evidence: `${con.file} imports ${className} from '${con.source}' (module unresolved)`, candidates: [{ symbol: con.file }] });
      unresolved.push({ node: className, query: "resolveModule", reason: `unresolved:${con.source}` });
      continue;
    }
    const rd = _read(repo, con.file);
    if (!rd) continue;
    const cctx = await makeCtx(rd[0], rd[1]);
    if (!cctx) continue;
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

  const nodes: any[] = [{ id: className, symbol: className, kind: "class", file: anchorFile, range: crange, enclosing: "", complexity: Math.max(1, crange[1] - crange[0] + 1) }];
  const edges: any[] = [];
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
  for (const [cfile, sym, kind, start, end, usage] of pending) {
    counter += 1;
    const cid = `c${counter}`;
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
  void nMethods; // depth-2 ripple (uses nodes[1+nMethods:]) lands in a later C4 slice

  return {
    version: 1,
    anchor: { id: className, symbol: className, file: anchorFile, range: crange },
    language: lang_for(anchorFile) ?? "",
    resolutionQuality: "FULL", depth, complete: true,
    nodes, edges, blindspots, unresolved,
  };
}
