// Port of src/diff/symbol_edges.py — deterministic symbol-grounded signals (the FLOOR
// the LLM passes build on). Pure functions of the diff text. See the Python docstring.
import type { Hunk } from "./parser.js";
import { _defs_refs, _diff_imports, _module_root, _salient_symbols, _IDENT } from "./lang.js";
import { difference, intersect, sorted, union, findAll } from "../core/sets.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function external_refs(hunks: Hunk[]): Map<string, { symbol: string; source: string }[]> {
  const imp = _diff_imports(hunks);
  const new_vocab = hunks.length
    ? union(...hunks.map((h) => _defs_refs(h.text)[0]))
    : new Set<string>();
  const out = new Map<string, { symbol: string; source: string }[]>();
  for (const h of hunks) {
    const refs = _defs_refs(h.text)[1];
    const pairs: [string, string][] = [];
    for (const s of sorted(refs))
      if (imp.has(s) && !new_vocab.has(s)) pairs.push([s, imp.get(s)!]);
    const scoped = pairs.filter(([, src]) => src && (src[0] === "@" || src[0] === "."));
    const chosen = scoped.length ? scoped : pairs;
    out.set(h.id, chosen.map(([s, src]) => ({ symbol: s, source: src })));
  }
  return out;
}

export function external_coupling(hunks: Hunk[]): Map<string, string[]> {
  const refs = external_refs(hunks);
  const out = new Map<string, string[]>();
  for (const [hid, rs] of refs)
    out.set(hid, sorted(new Set(rs.map((r) => _module_root(r.source)))));
  return out;
}

const _REWIRE_MAX = 2;

export function rewire_pairs(hunks: Hunk[]): Map<string, { removed: string[]; added: string[] }> {
  const out = new Map<string, { removed: string[]; added: string[] }>();
  for (const h of hunks) {
    const remLines: string[] = [], addLines: string[] = [];
    for (const ln of h.text.split("\n")) {
      if (ln.startsWith("-") && !ln.startsWith("---")) remLines.push(ln.slice(1));
      else if (ln.startsWith("+") && !ln.startsWith("+++")) addLines.push(ln.slice(1));
    }
    const remSym = _salient_symbols(remLines), addSym = _salient_symbols(addLines);
    const rem_only = sorted(difference(remSym, addSym));
    const add_only = sorted(difference(addSym, remSym));
    const crisp = rem_only.length && add_only.length
      && rem_only.length <= _REWIRE_MAX && add_only.length <= _REWIRE_MAX;
    out.set(h.id, crisp ? { removed: rem_only, added: add_only } : { removed: [], added: [] });
  }
  return out;
}

export function resolve_alias(
  used_symbols: Set<string>, candidate_cores: Map<string, Set<string>>, file_text: string,
): Map<string, Set<string>> {
  const lines = file_text.split("\n");
  const out = new Map<string, Set<string>>();
  for (const x of used_symbols) {
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`\\b(?:const|let|var|function)\\s+${escapeRe(x)}\\b`).test(lines[i])) {
        const block = lines.slice(i, i + 8).join("\n");
        for (const [cid, csyms] of candidate_cores) {
          for (const cs of csyms) {
            if (new RegExp(`\\b${escapeRe(cs)}\\b`).test(block)) {
              if (!out.has(cid)) out.set(cid, new Set());
              out.get(cid)!.add(x);
              break;
            }
          }
        }
        break;
      }
    }
  }
  return out;
}

function _coalesce(lines: number[], gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (const ln of lines) {
    if (out.length && ln - out[out.length - 1][1] <= gap) out[out.length - 1][1] = ln;
    else out.push([ln, ln]);
  }
  return out;
}

export function segment_link_by_core(
  link: Hunk, core_defs: Map<string, Set<string>>, gap = 10,
): Map<string, [number, number][]> {
  const body = link.text.split("\n").slice(1); // drop @@ header; body is 1-based
  const hits = new Map<string, number[]>();
  body.forEach((raw, idx) => {
    const ln = idx + 1;
    const toks = new Set(findAll(_IDENT, raw));
    for (const [cid, defs] of core_defs) {
      if (intersect(toks, defs).size) {
        if (!hits.has(cid)) hits.set(cid, []);
        hits.get(cid)!.push(ln);
      }
    }
  });
  const out = new Map<string, [number, number][]>();
  for (const [cid, lns] of hits) out.set(cid, _coalesce(sorted(new Set(lns)), gap));
  return out;
}

export function candidate_wirings(hunks: Hunk[]): Map<string, [string, string][]> {
  const dr = new Map<string, [Set<string>, Set<string>]>();
  for (const h of hunks) dr.set(h.id, _defs_refs(h.text));
  const new_vocab = dr.size
    ? union(...[...dr.values()].map(([d]) => d))
    : new Set<string>();
  const doc_freq = new Map<string, number>();
  for (const [d, r] of dr.values())
    for (const sym of intersect(union(d, r), new_vocab))
      doc_freq.set(sym, (doc_freq.get(sym) ?? 0) + 1);
  const ambient_cut = Math.max(5, Math.floor(hunks.length / 3));
  const distinctive = new Set<string>();
  for (const s of new_vocab) if ((doc_freq.get(s) ?? 0) <= ambient_cut) distinctive.add(s);

  const out = new Map<string, [string, string][]>();
  for (const h of hunks) out.set(h.id, []);
  const ids = hunks.map((h) => h.id);
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i];
    const [adef, aref] = dr.get(a)!;
    for (let j = i + 1; j < ids.length; j++) {
      const b = ids[j];
      const [bdef, bref] = dr.get(b)!;
      const shared = intersect(distinctive, union(intersect(adef, bref), intersect(bdef, aref)));
      for (const sym of sorted(shared)) {
        out.get(a)!.push([b, sym]);
        out.get(b)!.push([a, sym]);
      }
    }
  }
  return out;
}
