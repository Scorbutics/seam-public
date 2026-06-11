// Port of src/diff/subgroup.py — seam sub-grouping (the altitude mid-level between cluster
// and seam). Deterministic affinity (shared links + directory proximity + label tokens),
// average-linkage agglomeration, guarded so a small/tight cluster renders flat (returns null).
import type { SeamDict } from "./seams.js";

const _MIN_SEAMS = 7;
const _FLOOR = 1.0;
const _W_COUPLING = 1.6, _W_DIR = 1.0, _W_LABEL = 0.8;

const _STOP = new Set(["the", "and", "for", "with", "new", "view", "update", "add", "setup",
  "component", "components", "ui", "redesign", "management", "refactor"]);

interface Feat { label: string; dirs: string[][]; tok: Set<string>; shares: Set<string>; size: number; }

function _toks(label: string): Set<string> {
  const out = new Set<string>();
  for (const t of (label || "").toLowerCase().split(/[^a-z0-9]+/)) if (t.length > 2 && !_STOP.has(t)) out.add(t);
  return out;
}

function _dedupeDirs(dirs: string[][]): string[][] {
  const seen = new Map<string, string[]>();
  for (const d of dirs) seen.set(d.join("/"), d);
  return [...seen.values()];
}

function _features(seam: SeamDict): Feat {
  const dirs = _dedupeDirs(seam.blocks.map((b) => b.file.split("/").slice(0, -1)));
  return {
    label: seam.label || seam.id,
    dirs,
    tok: _toks(seam.label || ""),
    shares: new Set(seam.shares_with ?? []),
    size: seam.blocks.length,
  };
}

function _dir_proximity(da: string[][], db: string[][]): number {
  let best = 0.0;
  for (const x of da) for (const y of db) {
    let k = 0;
    for (let i = 0; i < Math.min(x.length, y.length); i++) { if (x[i] === y[i]) k++; else break; }
    best = Math.max(best, k / Math.max(x.length, y.length, 1));
  }
  return best;
}

function _affinity(a: string, b: string, f: Map<string, Feat>): number {
  const A = f.get(a)!, B = f.get(b)!;
  const coup = (A.shares.has(b) || B.shares.has(a)) ? 1.0 : 0.0;
  const dirp = _dir_proximity(A.dirs, B.dirs);
  const inter = [...A.tok].filter((t) => B.tok.has(t)).length;
  const uni = new Set([...A.tok, ...B.tok]).size;
  const lab = inter / Math.max(1, uni);
  return _W_COUPLING * coup + _W_DIR * dirp + _W_LABEL * lab;
}

function _hac(ids: string[], f: Map<string, Feat>, floor: number): string[][] {
  const groups = ids.map((i) => [i]);
  const groupAff = (g1: string[], g2: string[]): number => {
    const vals: number[] = [];
    for (const a of g1) for (const b of g2) vals.push(_affinity(a, b, f));
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0.0;
  };
  while (groups.length > 1) {
    let best = -1.0, bi = -1, bj = -1;
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const v = groupAff(groups[i], groups[j]);
        if (v > best) { best = v; bi = i; bj = j; }
      }
    if (best < floor) break;
    groups[bi].push(...groups[bj]);
    groups.splice(bj, 1);
  }
  return groups;
}

const _GENERIC_DIR = new Set(["src", "components", "component", "view", "views", "shared", "modules",
  "module", "apps", "app", "web", "packages", "package", "lib", "libs", "dialogs", "tabs",
  "pages", "page", "ui", "utils", "common", "core"]);

function _name(group: string[], f: Map<string, Feat>): string {
  // Counter with insertion-order tie-break (Python Counter.most_common).
  const seg_freq = new Map<string, number>();
  for (const i of group) for (const d of f.get(i)!.dirs) for (const seg of d)
    if (seg && !_GENERIC_DIR.has(seg.toLowerCase())) seg_freq.set(seg, (seg_freq.get(seg) ?? 0) + 1);
  if (seg_freq.size) {
    let bestSeg = "", bestN = -1;
    for (const [seg, n] of seg_freq) if (n > bestN) { bestN = n; bestSeg = seg; }
    return bestSeg;
  }
  let rep = group[0];
  for (const i of group) if (f.get(i)!.size > f.get(rep)!.size) rep = i;
  return f.get(rep)!.label;
}

export interface Subgroup { label: string; seamIds: string[]; }

export function subgroup_seams(seams: SeamDict[], minSeams = _MIN_SEAMS, floor = _FLOOR): Subgroup[] | null {
  if (seams.length <= minSeams) return null;
  const order = seams.map((s) => s.id);
  const orderIdx = (id: string) => order.indexOf(id);
  const f = new Map<string, Feat>();
  for (const s of seams) f.set(s.id, _features(s));
  const synthetic = seams.filter((s) => s.id.startsWith("s-")).map((s) => s.id);
  const real = seams.filter((s) => !s.id.startsWith("s-")).map((s) => s.id);
  const groups = real.length ? _hac(real, f, floor) : [];
  if (synthetic.length) groups.push(synthetic);
  if (groups.length <= 1) return null;
  groups.sort((a, b) => Math.min(...a.map(orderIdx)) - Math.min(...b.map(orderIdx)));
  const out: Subgroup[] = [];
  for (const g of groups) {
    let label: string;
    if (g.every((i) => i.startsWith("s-"))) label = "housekeeping";
    else if (g.length === 1) label = f.get(g[0])!.label;
    else label = _name(g, f);
    out.push({ label, seamIds: [...g].sort((x, y) => orderIdx(x) - orderIdx(y)) });
  }
  return out;
}
