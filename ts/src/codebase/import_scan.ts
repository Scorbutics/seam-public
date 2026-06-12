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
  if (akind === "class") {
    throw new Error("class anchor scan (build_class_graph) is the next C4 slice — see ts/PORT-STATUS.md");
  }
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
