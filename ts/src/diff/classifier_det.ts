// Port of src/diff/classifier_det.py — the deterministic-first classifier (roles + wiring +
// clusters + seam merge + spans). No regex/language knowledge beyond the facts IR + a few
// label heuristics. See the Python docstring for the model.
import { connected_components } from "../core/graph_ir.js";
import {
  type FactsProvider, type HunkFacts, RegexFactsProvider,
  leading_ambient_lines, new_side_lines,
} from "./facts.js";
import { _added, _defs_refs, _diff_imports, _STOP } from "./lang.js";
import { type Hunk, type Placement } from "./parser.js";
import { candidate_wirings, resolve_alias, segment_link_by_core } from "./symbol_edges.js";
import { difference, findAll, findGroup1, intersect, sorted, union } from "../core/sets.js";

const _LOGIC_CORE_THRESHOLD = 2;
const _AMBIENT_EXTERNAL_MIN = 3;
const _RECONCILE_GATE = 4;

const _CONF_TEST = 1.0, _CONF_ENV_IMPORT = 1.0, _CONF_ENV_DECL = 0.85, _CONF_ENV_SQL = 0.9;
const _CONF_ADAPTER = 0.8, _CONF_CORE_DEF_LOGIC = 0.9, _CONF_CORE_LOGIC = 0.7;
const _CONF_CORE_DEF = 0.65, _CONF_LINK = 0.8, _CONF_FALLBACK = 0.5;

// --- Python str case-method equivalents (Unicode-aware) ----------------------
const hasUpper = (s: string) => s.toLowerCase() !== s;          // any(c.isupper() for c in s)
const isUpperStr = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase(); // s.isupper()
const firstUpper = (s: string) => { const c = s.slice(0, 1); return c !== "" && c !== c.toLowerCase(); };
const firstLower = (s: string) => { const c = s.slice(0, 1); return c !== "" && c !== c.toUpperCase(); };
const hunkNum = (id: string) => (/^\d+$/.test(id.slice(1)) ? parseInt(id.slice(1), 10) : 0);

function normpath(p: string): string {
  // Minimal os.path.normpath: collapse `//`, resolve `.`/`..`. resolved_refs is empty on the
  // regex/det path, so this only needs to be self-consistent.
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  const res = out.join("/");
  return res === "" ? "." : (p.startsWith("/") ? "/" + res : res);
}

export function _subject_ok(s: string): boolean {
  return s.length >= 3 && !_STOP.has(s) && (hasUpper(s) || s.includes("_"));
}

function _subjects(f: HunkFacts): Set<string> {
  const out = new Set<string>();
  for (const s of f.defines) if (_subject_ok(s)) out.add(s);
  for (const s of f.enclosing) if (_subject_ok(s)) out.add(s);
  for (const s of f.calls) if (_subject_ok(s)) out.add(s);
  return out;
}

export function _mentions(f: HunkFacts): Set<string> {
  const out = new Set<string>(f.references);
  for (const s of f.calls) if (_subject_ok(s)) out.add(s);
  for (const s of f.enclosing) if (_subject_ok(s)) out.add(s);
  return out;
}

export function _anchors(work: Hunk[], facts: Map<string, HunkFacts>, cores: Set<string>): Map<string, Set<string>> {
  const subj = new Map<string, Set<string>>();
  for (const h of work) subj.set(h.id, _subjects(facts.get(h.id)!));
  const freq = new Map<string, number>();
  for (const ss of subj.values()) for (const s of ss) freq.set(s, (freq.get(s) ?? 0) + 1);
  const cut = Math.max(5, Math.floor(work.length / 3));
  const new_vocab = work.length ? union(...work.map((h) => facts.get(h.id)!.defines)) : new Set<string>();
  const external = difference(new Set(_diff_imports(work).keys()), new_vocab);
  const ambient_external = new Set<string>();
  for (const s of external) if ((freq.get(s) ?? 0) >= _AMBIENT_EXTERNAL_MIN) ambient_external.add(s);
  const out = new Map<string, Set<string>>();
  for (const cid of cores) {
    const set = new Set<string>();
    for (const s of subj.get(cid)!) if (freq.get(s)! <= cut && !ambient_external.has(s)) set.add(s);
    out.set(cid, set);
  }
  return out;
}

function _resolved_edges(work: Hunk[], facts: Map<string, HunkFacts>): Map<string, Set<string>> {
  const by_file = new Map<string, string[]>();
  for (const d of work) {
    const k = normpath(d.file_path);
    if (!by_file.has(k)) by_file.set(k, []);
    by_file.get(k)!.push(d.id);
  }
  const out = new Map<string, Set<string>>();
  for (const h of work) out.set(h.id, new Set());
  for (const h of work) {
    for (const tgt of Object.values(facts.get(h.id)!.resolved_refs)) {
      for (const did of by_file.get(normpath(tgt)) ?? []) if (did !== h.id) out.get(h.id)!.add(did);
    }
  }
  return out;
}

function _subject_wiring(work: Hunk[], facts: Map<string, HunkFacts>, cores: Set<string>): Map<string, string[]> {
  const anchors = _anchors(work, facts, cores);
  const out = new Map<string, string[]>();
  for (const h of work) {
    if (cores.has(h.id)) { out.set(h.id, []); continue; }
    const m = _mentions(facts.get(h.id)!);
    out.set(h.id, sorted([...cores].filter((cid) => cid !== h.id && intersect(anchors.get(cid)!, m).size)));
  }
  return out;
}

export function reconcile_wiring(work: Hunk[], facts: Map<string, HunkFacts>, gate = _RECONCILE_GATE): Hunk[] {
  const cores = new Set(work.filter((h) => h.role === "core").map((h) => h.id));
  const anchors = _anchors(work, facts, cores);
  const residual: Hunk[] = [];
  for (const h of work) {
    if (h.role === "core" || h.wires.length <= gate) continue;
    const m = _mentions(facts.get(h.id)!);
    const owned = h.wires.filter((c) => intersect(intersect(anchors.get(c) ?? new Set(), m), facts.get(c)!.defines).size);
    if (!owned.length) continue; // legitimate hub
    h.wires = sorted(owned);
    if (h.wires.length > gate) residual.push(h);
  }
  return residual;
}

export function grounded_prune(wires: Set<string>, grounded: Set<string>, gate = _RECONCILE_GATE): [Set<string>, Set<string>] {
  let kept = new Set(wires);
  if (kept.size > gate && intersect(kept, grounded).size) kept = intersect(kept, grounded);
  return [kept, difference(kept, grounded)];
}

const _SECTION_DEF = /\b(?:function|class|interface|enum|const|let|var|val|def|fun)\s+([A-Za-z_][\p{L}\p{N}_]*)/gu;
const sectionDefSearch = (s: string): string => { const g = findGroup1(_SECTION_DEF, s); return g.length ? g[0] : ""; };

function _primary_symbol(f: HunkFacts, h: Hunk, distinctive: Set<string>): string {
  let enclosing_def = sectionDefSearch(h.section_header || "");
  if (!enclosing_def) {
    enclosing_def = findGroup1(_SECTION_DEF, h.text).find((n) => firstUpper(n) && !isUpperStr(n)) ?? "";
  }
  let pref = sorted(intersect(f.defines, distinctive));
  if (!pref.length) pref = sorted(f.defines);
  const best = pref.length ? (pref.find((s) => !isUpperStr(s)) ?? pref[0]) : "";
  const enc_is_component = !!enclosing_def && firstUpper(enclosing_def) && !isUpperStr(enclosing_def);
  if (enclosing_def && (!best
      || (firstLower(best) && firstUpper(enclosing_def))
      || (isUpperStr(best) && enc_is_component))) return enclosing_def;
  if (best) return best;
  if (enclosing_def) return enclosing_def;
  const stem = (h.file_path || "").split("/").pop()!.split(".")[0];
  return stem || h.id;
}

// --------------------------------------------------------------------------- passes
function _distinctive(work: Hunk[]): Set<string> {
  const out = new Set<string>();
  for (const edges of candidate_wirings(work).values()) for (const [, sym] of edges) out.add(sym);
  return out;
}

export function assign_roles(work: Hunk[], facts: Map<string, HunkFacts>): void {
  const cand = candidate_wirings(work);
  const dr = new Map<string, [Set<string>, Set<string>]>();
  for (const h of work) dr.set(h.id, [facts.get(h.id)!.defines, facts.get(h.id)!.references]);
  const pure_refs = new Map<string, Set<string>>();
  for (const [hid, [defs, refs]] of dr) pure_refs.set(hid, difference(refs, defs));
  const referenced = new Set<string>();
  const targets = new Map<string, Set<string>>();
  for (const h of work) targets.set(h.id, new Set());
  for (const [hid, edges] of cand) {
    const hdefs = dr.get(hid)![0];
    for (const [other, sym] of edges) {
      if (hdefs.has(sym) && (pure_refs.get(other) ?? new Set()).has(sym)) {
        referenced.add(hid);
        targets.get(other)!.add(hid);
      }
    }
  }
  for (const [hid, definers] of _resolved_edges(work, facts)) {
    targets.set(hid, union(targets.get(hid)!, definers));
  }

  for (const h of work) {
    const f = facts.get(h.id)!;
    if (f.is_test) { h.role = "test"; h.role_confidence = _CONF_TEST; h.rationale = "test — verifies the change (path/framework markers)"; }
    else if (f.is_sql) { h.role = "environment"; h.role_confidence = _CONF_ENV_SQL; h.rationale = "environment — SQL schema/data migration (trust delegated)"; }
    else if (f.imports_only || f.type_decl_only) {
      h.role = "environment";
      h.role_confidence = f.imports_only ? _CONF_ENV_IMPORT : _CONF_ENV_DECL;
      h.rationale = f.imports_only ? "environment — imports wiring the change in" : "environment — type/declaration only, no logic";
    } else if (f.implements.size) {
      h.role = "link"; h.role_confidence = _CONF_ADAPTER; h.rationale = "link — adapter implementing an interface (connects, not decides)";
    } else {
      const defines_ref = referenced.has(h.id);
      const logic = f.decisions;
      const uses = targets.get(h.id)!.size > 0;
      if (defines_ref && logic >= 1) { h.role = "core"; h.role_confidence = _CONF_CORE_DEF_LOGIC; h.rationale = "core — defines logic other hunks depend on"; }
      else if (logic >= _LOGIC_CORE_THRESHOLD) { h.role = "core"; h.role_confidence = _CONF_CORE_LOGIC; h.rationale = "core — substantial new behavioral logic"; }
      else if (defines_ref) { h.role = "core"; h.role_confidence = _CONF_CORE_DEF; h.rationale = "core — defines a symbol other hunks depend on"; }
      else if (uses) { h.role = "link"; h.role_confidence = _CONF_LINK; h.rationale = "link — references a core's symbol (wires it in)"; }
      else if (logic >= 1) { h.role = "core"; h.role_confidence = _CONF_FALLBACK; h.rationale = "core — some new logic, no clear wiring (uncertain)"; }
      else { h.role = "environment"; h.role_confidence = _CONF_FALLBACK; h.rationale = "environment — no logic or wiring detected (uncertain)"; }
    }
  }
}

export function assign_wiring(work: Hunk[], facts: Map<string, HunkFacts>): void {
  const distinctive = _distinctive(work);
  const cores = new Set(work.filter((h) => h.role === "core").map((h) => h.id));
  const wires_map = _subject_wiring(work, facts, cores);
  const res_edges = _resolved_edges(work, facts);
  for (const h of work) {
    if (h.role === "core") {
      h.seam = h.id; h.seam_label = _primary_symbol(facts.get(h.id)!, h, distinctive);
      h.wires = []; h.resolved_wires = [];
    } else {
      const rwires = new Set<string>();
      for (const c of res_edges.get(h.id)!) if (cores.has(c) && c !== h.id) rwires.add(c);
      h.wires = sorted(union(new Set(wires_map.get(h.id)!), rwires));
      h.resolved_wires = sorted(rwires);
      h.seam = ""; h.seam_label = "";
    }
    h.suggested_wires = [];
    h.spans = [];
  }
}

export function _enclosing(c: Hunk): string {
  return sectionDefSearch(c.section_header || "");
}

export function merge_seams(work: Hunk[]): void {
  const cores = work.filter((h) => h.role === "core");
  const groups = new Map<string, Hunk[]>();
  for (const c of cores) {
    const enc = _enclosing(c);
    const gkey = enc ? `${c.file_path} ${enc}` : `${c.file_path} ${c.id}`;
    if (!groups.has(gkey)) groups.set(gkey, []);
    groups.get(gkey)!.push(c);
  }
  const remap = new Map<string, string>();
  for (const members of groups.values()) {
    members.sort((a, b) => hunkNum(a.id) - hunkNum(b.id));
    const rep = members[0];
    const enc = _enclosing(rep);
    const label = rep.seam_label || enc || rep.id;
    for (const c of members) { c.seam = rep.id; c.seam_label = label; c.group = rep.group; remap.set(c.id, rep.id); }
  }
  for (const h of work) {
    if (h.role !== "core" && h.wires.length) h.wires = sorted(new Set(h.wires.map((w) => remap.get(w) ?? w)));
  }
}

export function assign_clusters(work: Hunk[], facts: Map<string, HunkFacts>): void {
  const distinctive = _distinctive(work);
  const edges: [string, string][] = [];
  for (const h of work) for (const t of h.wires) edges.push([h.id, t]);
  const groups = connected_components(work.map((h) => h.id), edges);
  const members = new Map<string, Hunk[]>();
  for (const h of work) {
    h.group = groups.get(h.id)!;
    if (!members.has(h.group)) members.set(h.group, []);
    members.get(h.group)!.push(h);
  }
  for (const hs of members.values()) {
    const cs = hs.filter((h) => h.role === "core");
    let rep: Hunk;
    if (cs.length) {
      rep = cs.reduce((a, b) => (facts.get(b.id)!.decisions > facts.get(a.id)!.decisions ? b : a));
    } else rep = hs[0];
    const intent = cs.length ? _primary_symbol(facts.get(rep.id)!, rep, distinctive)
      : (rep.section_header || (rep.file_path || "").split("/").pop() || rep.id);
    for (const h of hs) h.intent = intent;
  }
}

function _overlap_subgroups(members: Hunk[], facts: Map<string, HunkFacts>): string[][] {
  const footprint = (c: Hunk): Set<string> => {
    const f = facts.get(c.id)!;
    const out = new Set<string>();
    const enc = _enclosing(c);
    for (const s of union(f.defines, f.calls)) if (_subject_ok(s) && s !== enc) out.add(s);
    return out;
  };
  const ids = members.map((c) => c.id);
  const foot = new Map<string, Set<string>>();
  for (const c of members) foot.set(c.id, footprint(c));
  const parent = new Map(ids.map((i) => [i, i]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (intersect(foot.get(ids[i])!, foot.get(ids[j])!).size) parent.set(find(ids[i]), find(ids[j]));
  const out = new Map<string, string[]>();
  for (const i of ids) { const r = find(i); if (!out.has(r)) out.set(r, []); out.get(r)!.push(i); }
  return [...out.values()];
}

// Merge cores into technical-intent seams for the hybrid path — union of det floor (same file +
// enclosing, overlap-subpartitioned) + LLM grouping (same seam key OR same label). Port of
// classifier_det.apply_seam_groups.
export function apply_seam_groups(work: Hunk[], labels: Map<string, string>, groups: Map<string, string>,
                                  useComponentFloor = true, facts?: Map<string, HunkFacts>): void {
  const cores = work.filter((h) => h.role === "core");
  const parent = new Map(cores.map((c) => [c.id, c.id]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const unite = (a: string, b: string) => { parent.set(find(a), find(b)); };

  const compGroups: string[][] = [];
  if (useComponentFloor) {
    const byComp = new Map<string, Hunk[]>();
    for (const c of cores) {
      const enc = _enclosing(c);
      if (enc) { const k = `${c.file_path} ${enc}`; if (!byComp.has(k)) byComp.set(k, []); byComp.get(k)!.push(c); }
    }
    for (const members of byComp.values()) {
      if (!facts || members.length <= 1) compGroups.push(members.map((c) => c.id));
      else compGroups.push(..._overlap_subgroups(members, facts));
    }
  }
  const bykey = new Map<string, string[]>();
  for (const c of cores) {
    if (groups.get(c.id)) { const k = "k:" + groups.get(c.id); if (!bykey.has(k)) bykey.set(k, []); bykey.get(k)!.push(c.id); }
    const lab = (labels.get(c.id) || "").trim().toLowerCase();
    if (lab) { const k = "l:" + lab; if (!bykey.has(k)) bykey.set(k, []); bykey.get(k)!.push(c.id); }
  }
  for (const ids of [...compGroups, ...bykey.values()]) for (const x of ids.slice(1)) unite(ids[0], x);

  const remap = new Map<string, string>();
  const seamMembers = new Map<string, Hunk[]>();
  for (const c of cores) { const r = find(c.id); if (!seamMembers.has(r)) seamMembers.set(r, []); seamMembers.get(r)!.push(c); }
  for (const members of seamMembers.values()) {
    members.sort((a, b) => hunkNum(a.id) - hunkNum(b.id));
    const rep = members[0];
    const distinct = new Set(members.map((c) => (labels.get(c.id) || "").trim().toLowerCase()).filter((l) => l));
    const label = distinct.size > 1
      ? (_enclosing(rep) || labels.get(rep.id) || rep.seam_label || rep.id)
      : (labels.get(rep.id) || _enclosing(rep) || rep.seam_label || rep.id);
    for (const c of members) { c.seam = rep.id; c.seam_label = label; c.group = rep.group; remap.set(c.id, rep.id); }
  }
  for (const h of work) {
    if (h.role !== "core" && h.wires.length) {
      h.wires = sorted(new Set(h.wires.map((w) => remap.get(w) ?? w)));
      if (h.suggested_wires.length) h.suggested_wires = sorted(new Set(h.suggested_wires.map((w) => remap.get(w) ?? w)));
    }
  }
}

export function merge_clusters_by_intent(work: Hunk[]): void {
  const rep = new Map<string, string>();
  const remap = new Map<string, string>();
  for (const h of work) {
    const g = h.group;
    if (!g || remap.has(g)) continue;
    const key = (h.intent || "").trim().toLowerCase();
    if (!key) { remap.set(g, g); continue; }
    if (!rep.has(key)) rep.set(key, g);
    remap.set(g, rep.get(key)!);
  }
  for (const h of work) if (h.group) h.group = remap.get(h.group) ?? h.group;
}

// --------------------------------------------------------------------------- spans / overlap
function _locate(h: Hunk, targets: Map<string, Set<string>>, nmap: Map<number, number | null>,
                 seam_of: Map<string, string>): Map<string, [number, number]> {
  const seg = segment_link_by_core(h, targets);
  const spans = new Map<string, [number, number]>();
  for (const [cid, ranges] of seg) {
    const flines: number[] = [];
    for (const [s, e] of ranges) for (let ln = s; ln <= e; ln++) { const fl = nmap.get(ln); if (fl != null) flines.push(fl); }
    if (flines.length) spans.set(seam_of.get(cid) ?? cid, [Math.min(...flines), Math.max(...flines)]);
  }
  return spans;
}

export function assign_spans(work: Hunk[], repo?: string): void {
  const core_defs = new Map<string, Set<string>>();
  const seam_of = new Map<string, string>();
  for (const h of work) if (h.role === "core") { core_defs.set(h.id, _defs_refs(h.text)[0]); seam_of.set(h.id, h.seam || h.id); }
  const def_freq = new Map<string, number>();
  for (const defs of core_defs.values()) for (const s of defs) def_freq.set(s, (def_freq.get(s) ?? 0) + 1);

  for (const h of work) {
    h.placements = [];
    const nmap = new_side_lines(h);
    if (h.role === "core" || h.role === "link") {
      const k = leading_ambient_lines(h);
      if (k) {
        const head: number[] = [], rest: number[] = [];
        for (let i = 1; i <= k; i++) { const fl = nmap.get(i); if (fl != null) head.push(fl); }
        for (let i = k + 1; i < h.text.split("\n").length; i++) { const fl = nmap.get(i); if (fl != null) rest.push(fl); }
        if (head.length && rest.length)
          h.placements.push({ seam: "", role: "environment", start: Math.min(...head), end: Math.max(...head) } as Placement);
      }
    }
    if (h.role === "core") {
      const own = h.seam || h.id;
      const sib = new Map<string, Set<string>>();
      for (const [cid, d] of core_defs) {
        if (cid === h.id || seam_of.get(cid) === own) continue;
        const set = new Set<string>();
        for (const s of d) if (def_freq.get(s)! <= 1) set.add(s);
        if (set.size) sib.set(cid, set);
      }
      const spans = sib.size ? _locate(h, sib, nmap, seam_of) : new Map<string, [number, number]>();
      spans.delete(own);
      for (const [seam, [s, e]] of spans) h.placements.push({ seam, role: "link", start: s, end: e } as Placement);
    } else if (h.role === "link" || h.role === "environment") {
      const wired = h.wires.filter((c) => core_defs.has(c));
      if (wired.length >= 2) {
        const cd = new Map<string, Set<string>>();
        for (const c of wired) cd.set(c, new Set(core_defs.get(c)!));
        const seg = segment_link_by_core(h, cd);
        const unlocated = wired.filter((c) => !seg.has(c));
        if (unlocated.length && repo) {
          // alias resolution against the working-tree file — best-effort, needs fs; skipped
          // in the default classify() (no repo). Left as a TODO for the CLI fs path.
        }
        const spans = _locate(h, cd, nmap, seam_of);
        if (spans.size >= 2) for (const [seam, [s, e]] of spans) h.placements.push({ seam, role: h.role!, start: s, end: e } as Placement);
      }
    }
  }
}

export function classify(hunks: Hunk[], opts: { facts_provider?: FactsProvider } = {}): void {
  const work = hunks.filter((h) => h.role !== "noise");
  if (!work.length) return;
  const facts = (opts.facts_provider ?? new RegexFactsProvider()).facts(work);
  assign_roles(work, facts);
  assign_wiring(work, facts);
  reconcile_wiring(work, facts);
  assign_clusters(work, facts);
  merge_seams(work);
  assign_spans(work);
}
