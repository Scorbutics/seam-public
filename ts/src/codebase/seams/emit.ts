// emit (SeamModel): assemble the final hunks/seams/clusters payload from the graph + the seam partition —
// core-grouped ordering, caller-fan capping, dedup, region metadata, the structural-spine lock, git lineage,
// and the decision-point frontier.
import { type Graph, type Node, bfsDistance } from "../../core/graph_ir.js";
import { RENDER } from "../config.js";
import { git_lineage } from "../lineage.js";
import { type Seam } from "./clusters.js";
import { _spine_order, _structural_spine } from "./spine.js";
import { BOUND_KINDS as _BOUND_KINDS } from "../render/medium_registry.js";
import { to1OrNone } from "../../core/lines.js";

// THE LINE CONTRACT, seam-model side (core/lines.ts). The Graph IR stays 0-BASED — `scan/detect.ts` slices the
// file with `node.start/end` and hands them to tree-sitter as row INDICES, so shifting them there would corrupt
// every contract/subcore span. This function is the internal→MODEL boundary (the codebase mirror of diff mode's
// `emit_seams_json`, whose hunks are already 1-based new-side file lines), so the +1 happens HERE, once: every
// `start`/`end`/`line` leaving emit is 1-BASED and every consumer of the model (the agent/concern spine, the
// seam hunks, `--from-seams`) cites a line that really holds the code. The grow renders were the last shape
// still printing the raw 0-based value (`core.target (src/core.ts:2)` for a declaration on line 3).
// An UNLOCATED node keeps the [0,0] sentinel (0 = "no line" — the renderers print no location, never `:1`).
const _mstart = (n: Node): number => (n.start > 0 || n.end > 0 ? n.start + 1 : 0);
const _mend = (n: Node): number => (n.start > 0 || n.end > 0 ? n.end + 1 : 0);

// BOUNDARY (shared-key medium) node kinds — the crossing sites, NOT code. The seam hunk carries `kind` only for
// these (a route labelled by its op, a table, a queue, a service handle…) so the render can name/ground the
// boundary; code hunks (method/function/class/module) omit `kind`, keeping the call-graph oracle fixtures stable.
// Sourced from the registry BOUND_KINDS (the source of truth) so a new medium (e.g. `service`) is included with
// no parallel list to keep in sync — CLAUDE.md: structural sets come from the registry, never a hardcoded copy.
const _BOUNDARY_KINDS = _BOUND_KINDS;
const _FAN_CAP = RENDER.fanCap;   // a seam with more than this many inline call-sites is a guard/policy fan → cap + summarize
// Decision-point frontier cap (Phase 2.2): the ranked list is capped so the render stays scannable; the OVERFLOW
// count is reported (`frontierCut`) — no silent truncation (I3). Env-overridable, mirrors the other grow toggles.
const _FRONTIER_CAP = Math.max(1, parseInt(process.env.SEAM_FRONTIER_CAP ?? "20", 10) || 20);

function _seam_hunk(n: Node, provenance: string): any {
  const out: any = {
    id: n.id, file: n.file, start: _mstart(n), end: _mend(n), role: n.role,
    confidence: Math.round(n.role_confidence * 100) / 100, label: n.label,
    provenance, relevant: n.relevant, external: [], externalRefs: [], rewire: null,
    direction: n.direction,
  };
  if (n.enclosing && n.enclosing !== n.label) out.enclosing = n.enclosing;   // owning class → the render QUALIFIES `Class.method`; `label` stays bare for handles/center-matching
  if (_BOUNDARY_KINDS.has(n.kind)) out.kind = n.kind;   // carry the medium kind for BOUNDARY nodes only (route/table/queue/…) so the render can name an op-labelled route; code hunks stay unchanged (oracle-stable)
  if (n.subcores.length) out.subcores = n.subcores;
  if (n.contract.length) out.contract = n.contract;
  if (n.hub) out.hub = n.hub;   // COLLAPSED hub marker (reason/fan/sampleConsumers) — additive, present only under hubCollapse (I2)
  return out;
}

function _seam_contracts(g: Graph, seams: Seam[]): any[] {
  const nodeSeams = new Map<string, Set<string>>();
  for (const s of seams) for (const nid of s.node_ids) { if (!nodeSeams.has(nid)) nodeSeams.set(nid, new Set()); nodeSeams.get(nid)!.add(s.id); }
  const pairs = new Map<string, any[]>();
  const seen = new Set<string>();
  for (const e of g.resolved_edges()) {
    if (e.kind === "contains") continue;
    for (const a of nodeSeams.get(e.src) ?? []) for (const b of nodeSeams.get(e.dst) ?? []) {
      if (a === b) continue;
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      const dk = `${key} ${e.src} ${e.dst} ${e.kind}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key)!.push({ from: e.src, to: e.dst, kind: e.kind, provenance: e.provenance, line: to1OrNone(e.line) });
    }
  }
  const out: any[] = [];
  for (const [key, links] of pairs) {
    const [a, b] = key.split(" ");
    out.push({ seamA: a, seamB: b, links, blurry: links.some((l) => l.provenance !== "RESOLVED_FULL") });
  }
  return out;
}

export function emit_seams(g: Graph, health: any, seams: Seam[], opts: { shape?: "policy" | "flow"; lead?: "backward" | "forward" | "both"; lineageRepo?: string; intent?: boolean } = {}): any {
  const edgeProv = new Map<string, string>();
  for (const e of g.resolved_edges()) edgeProv.set(`${e.src} ${e.dst}`, e.provenance);
  const seamWarnings: Map<string, string[]> = health.seam_warnings;
  const nodeWarnings: Map<string, string[]> = health.node_warnings;
  const anchorSym = g.nodes.has(g.anchor) ? g.nodes.get(g.anchor)!.label : "";

  const provOf = (nid: string, others: Set<string>): string => {
    for (const o of others) { const p = edgeProv.get(`${nid} ${o}`) ?? edgeProv.get(`${o} ${nid}`); if (p) return p; }
    return "RESOLVED_FULL";
  };

  const fileLine = (a: any, b: any) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start);
  // REGION metadata — the flood-fill's NATURAL shape (what replaces a linear spine): each node's HOP DISTANCE
  // from the anchor (the wave shell it was reached on) + the DIRECTION it was reached from (↑ consumers /
  // ↓ deps). A seam's `shell` = its nearest node; `direction` = its dominant. BFS over the UNDIRECTED resolved
  // graph, computed once. Intent-gated on emit → non-intent oracles stay byte-identical. (The region view reads
  // this; the spine is being retired in favour of it.)
  const _dist = bfsDistance(g.adjacency(), [g.anchor]);
  const _seamRegion = (ids: string[]): { shell: number; direction: string } => {
    const shells = ids.map((i) => _dist.get(i)).filter((d): d is number => d !== undefined);
    const dirs = ids.map((i) => (g.nodes.get(i) as any)?.direction).filter(Boolean);
    const up = dirs.filter((d) => d === "forward").length, down = dirs.filter((d) => d === "backward").length;
    return { shell: shells.length ? Math.min(...shells) : -1, direction: up && down ? "both" : down ? "down" : up ? "up" : "" };
  };
  const outSeams: any[] = [];
  for (const s of seams) {
    const ids = [...s.node_ids].sort((i, j) => fileLine(g.nodes.get(i)!, g.nodes.get(j)!));
    const idset = new Set(ids);
    const hunks: any[] = ids.map((i) => _seam_hunk(g.nodes.get(i)!, g.nodes.get(i)!.role === "core" ? "RESOLVED_FULL" : provOf(i, idset)));
    const callerDst = new Map<any, string>(); // a caller hunk wires the seam member it calls (edge dst)
    const seenC = new Set<string>();
    const callerHunks: any[] = [];
    for (const e of g.resolved_edges()) {
      if (e.kind === "contains" || !idset.has(e.dst) || idset.has(e.src)) continue;
      const c = g.nodes.get(e.src);
      if (!c || seenC.has(`${e.src} ${e.dst}`)) continue;
      seenC.add(`${e.src} ${e.dst}`);
      const cl = e.line && e.line > 0 ? to1OrNone(e.line) : _mstart(c);   // the CALL site (1-based), else the caller's own declaration
      const ch = { id: `call:${e.src}:${e.dst}`, file: c.file, start: cl, end: cl, role: "link",
        confidence: 0.9, label: c.label, caller: true, provenance: e.provenance, relevant: c.relevant,
        external: [], externalRefs: [], rewire: null };
      callerHunks.push(ch);
      callerDst.set(ch, e.dst);
    }
    // CAP a wide caller fan: a policy guard called from N sites would pile N inline caller hunks into one
    // unreviewable seam — but those callers are already their own seams (terminal-promoted) and in
    // `seamContracts`. Keep a few (file/line order) + a "+N more call sites" summary. Structural, agnostic.
    if (callerHunks.length > _FAN_CAP) {
      callerHunks.sort(fileLine);
      for (const ch of callerHunks.slice(_FAN_CAP)) callerDst.delete(ch);
      const more = callerHunks.length - _FAN_CAP;
      callerHunks.splice(_FAN_CAP, more, { id: `call:more:${s.id}`, file: "", start: 0, end: 0, role: "link",
        confidence: 0.9, label: `+${more} more call site(s)`, caller: true, summary: true,
        provenance: "RESOLVED_FULL", relevant: true, external: [], externalRefs: [], rewire: null });
    }
    for (const ch of callerHunks) hunks.push(ch);
    // Core-grouped ordering (replaces the flat file/line sort): each core, then the members that wire
    // it, so a link sits next to what it links. Wiring is the REAL resolved graph here — a member
    // connected (either direction) to a core in this seam, and a caller to the core it calls. A
    // multi-wired member lands under its earliest core; unwired members + ambient trail; a coreless
    // seam has no anchor, so it stays pure file/line.
    const corePresent = new Set(ids.filter((i) => g.nodes.get(i)!.role === "core"));
    const memberCores = new Map<string, string[]>(); // seam member id → connected core ids (file/line)
    for (const e of g.resolved_edges()) {
      if (e.kind === "contains") continue;
      for (const [m, c] of [[e.src, e.dst], [e.dst, e.src]] as [string, string][]) {
        if (idset.has(m) && corePresent.has(c) && g.nodes.get(m)!.role !== "core") {
          const arr = memberCores.get(m) ?? memberCores.set(m, []).get(m)!;
          if (!arr.includes(c)) arr.push(c);
        }
      }
    }
    for (const arr of memberCores.values()) arr.sort((a, b) => fileLine(g.nodes.get(a)!, g.nodes.get(b)!));
    const primaryCore = (h: any): string | null => {
      if (h.role === "core") return null;
      const dst = callerDst.get(h);
      if (dst !== undefined) return corePresent.has(dst) ? dst : (memberCores.get(dst)?.[0] ?? null);
      return memberCores.get(h.id)?.[0] ?? null;
    };
    const coreHunks = hunks.filter((h) => h.role === "core").sort(fileLine);
    const childrenOf = new Map<string, any[]>(), trailing: any[] = [];
    for (const h of hunks) {
      if (h.role === "core") continue;
      const pc = primaryCore(h);
      if (pc) (childrenOf.get(pc) ?? childrenOf.set(pc, []).get(pc)!).push(h);
      else trailing.push(h);
    }
    const ordered: any[] = [];
    for (const ch of coreHunks) { ordered.push(ch); for (const k of (childrenOf.get(ch.id) ?? []).sort(fileLine)) ordered.push(k); }
    for (const t of trailing.sort(fileLine)) ordered.push(t);
    // DEDUP by (file, span) — the flood-fill can re-reach the same logical node under DIFFERENT ids (and a
    // caller hunk can land on a member's line), so the same code location would otherwise render as several
    // identical refs in one seam. Keep the FIRST in core-grouped order (the most representative). The summary
    // fan hunk (file="") is exempt. Presentation-only; a diff has no such re-reach so it's a no-op there.
    const _seenLoc = new Set<string>();
    const deduped = ordered.filter((h) => { if (!h.file) return true; const k = `${h.file}:${h.start}:${h.end}`; return _seenLoc.has(k) ? false : (_seenLoc.add(k), true); });
    const warns: string[] = [];
    for (const i of ids) for (const w of [...(seamWarnings.get(i) ?? []), ...(nodeWarnings.get(i) ?? [])]) if (!warns.includes(w)) warns.push(w);
    // The seam's REPRESENTATIVE (a trustworthy "this is where it lives" pointer): the anchor if this seam
    // holds it, else the highest-complexity CORE (the defining symbol), else the heaviest node — NOT the
    // file/line-first hunk, which is often a neighbour the seam merely wires. Consumers point here.
    const byCx = (a: string, b: string) => (g.nodes.get(b)!.complexity ?? 0) - (g.nodes.get(a)!.complexity ?? 0);
    const pid = ids.includes(g.anchor) ? g.anchor
      : ([...ids].filter((i) => g.nodes.get(i)!.role === "core").sort(byCx)[0] ?? [...ids].sort(byCx)[0]);
    const pn = pid ? g.nodes.get(pid) : undefined;
    outSeams.push({ id: s.id, label: s.label, linkOnly: s.linkOnly, uncertain: false, warnings: warns,
      hunks: deduped, proposedBy: s.proposedBy ?? "floor", selected: s.selected ?? false, suggested: s.suggested ?? false,
      tier: s.tier, ...(pn ? { primary: { file: pn.file, line: _mstart(pn), symbol: pn.label } } : {}),
      // Intent pass only (additive + conditional → non-intent *_seams oracles stay byte-identical).
      ...(s.culmination !== undefined ? { culmination: s.culmination } : {}),
      ...(opts.intent ? { region: _seamRegion(ids) } : {}),   // wave-shell + direction (the region view's structure)
      ...(s.writes && s.writes.length ? { writes: s.writes } : {}), ...(s.dir ? { dir: s.dir } : {}) });
  }

  // STRUCTURAL spine (intent footprints only): lock the crossing-backbone seams to tier=spine BEFORE the
  // tier-based ordering, so the main path is decided by topology (the data-flow boundaries grow traced) and
  // holds even under skeleton — when the LLM seam-intent pass is skipped and the embedding tiers land
  // AFTER emit. Without this the spine was whatever the embedding banded top-third, so a role-enum whose
  // doc says "database" out-ranked the actual UI→DB chain. Locked on BOTH the raw seams (read by
  // _spine_order) and the emitted copies (read by the renderer + the embedding banding, which preserves a
  // locked spine and only bands the rest). Gated on `intent` → non-intent *_seams oracles stay byte-identical.
  if (opts.intent) {
    const sp = new Set(_structural_spine(g, seams, opts.lead));
    if (sp.size) { for (const s of seams) if (sp.has(s.id)) s.tier = "spine"; for (const s of outSeams) if (sp.has(s.id)) s.tier = "spine"; }
  }
  // INTENT MAP: tier each seam and order them as a trace — the spine (main path, anchor→…→display) first,
  // then supporting, then off-intent side-effects last. Untiered (no intent pass) → all rank equal → the
  // original order is preserved (no regression). The spine is BFS-ordered so the path reads top-to-bottom.
  const spine = _spine_order(g, seams, opts.lead);
  const spineRank = new Map(spine.map((id, i) => [id, i]));
  const tierRank = (t?: string) => (t === "spine" ? 0 : t === "off" ? 2 : 1);
  const origIdx = new Map(outSeams.map((s, i) => [s.id, i]));
  outSeams.sort((a, b) =>
    (tierRank(a.tier) - tierRank(b.tier)) ||
    ((spineRank.get(a.id) ?? 1e9) - (spineRank.get(b.id) ?? 1e9)) ||
    (origIdx.get(a.id)! - origIdx.get(b.id)!));

  // GIT LINEAGE (opt-in, additive): attach the last-touching commit of each seam's primary file — the
  // "why" layer, 100% deterministic (git ground truth). Conditional on lineageRepo, so the oracle
  // fixtures (which never set it) stay byte-identical.
  if (opts.lineageRepo) {
    const files = outSeams.map((s: any) => s.primary?.file).filter(Boolean);
    if (files.length) {
      const lin = git_lineage(opts.lineageRepo, files);
      for (const s of outSeams) { const l = s.primary && lin.get(s.primary.file); if (l) s.lineage = l; }
    }
  }
  const selectedSeam = outSeams.find((s) => s.selected)?.id ?? "";
  // DECISION-POINT FRONTIER (tier-grow, intent only) — the tier-3 residue as a ranked, capped list the caller
  // deepens from. Filter to nodes still PRESENT after all crops (a decision point removed by a later crop is no
  // longer one), cap, and REPORT the overflow (`frontierCut`) — collapse, never silently drop (I3/I2 additive).
  const _frontierAll = (opts.intent ? g.frontier.filter((f) => g.nodes.has(f.id)) : []);
  const _frontier = _frontierAll.slice(0, _FRONTIER_CAP);
  // CULMINATION RANKING (intent pass only): the climax as a RANKED list with confidence + the structural
  // facts that grounded it — what an LLM consumer reads instead of the fragile single `selectedSeam` ★.
  // Conditional, so non-intent footprints (the oracle fixtures) omit it and stay byte-identical.
  const culminationRanked = outSeams
    .filter((s) => typeof s.culmination === "number")
    .map((s) => ({ id: s.id, label: s.label, score: s.culmination as number, tier: s.tier,
      writes: s.writes ?? [], dir: s.dir ?? null }))
    .sort((a, b) => b.score - a.score);
  // The footprint is a flood-fill REGION, not a linear spine/path — the per-seam `region` (shell + direction)
  // + relevance tier ARE the structure now, so we no longer emit `spine` (an ordered trace) or `paths`
  // (per-crossing flows). The `tier` stays as the relevance band the region view dims by.
  const clusters = [{ id: "g1", intent: anchorSym || g.anchor, colorIndex: 0, seams: outSeams,
    ...(culminationRanked.length ? { culminationRanked } : {}) }];
  const tests = [...g.nodes.values()].filter((n) => n.role === "test").map((n) => _seam_hunk(n, "RESOLVED_FULL"));
  // DEDUP shared-key-fanout blindspots BY TABLE — a hub table (`user`) is written/read by dozens of nodes, and each
  // recorded its OWN fanout blindspot ("`user` is a hub, fanned"), so `user` appeared 32×, `membership` 18×… inflating
  // the blindspot count to hundreds of redundant duplicates. The render already summarises them into ONE line per
  // table, so collapse the MODEL to one per table too — keep the WIDEST-fan representative (most candidates), drop the
  // rest. Non-fanout blindspots (real per-node leads) are untouched. Halves-plus the count with zero signal loss.
  const _fanTable = (b: any): string | null => b.mechanism === "shared-key-fanout" ? (String(b.evidence ?? "").match(/'([^']+)'/)?.[1] ?? String(b.node)) : null;
  const _bsIdx = new Map<string, number>();
  const _blindspots: typeof g.blindspots = [];
  for (const b of g.blindspots) {
    const t = _fanTable(b);
    if (t === null) { _blindspots.push(b); continue; }
    const prev = _bsIdx.get(t);
    if (prev === undefined) { _bsIdx.set(t, _blindspots.length); _blindspots.push(b); }
    else if ((b.candidates?.length ?? 0) > (_blindspots[prev].candidates?.length ?? 0)) _blindspots[prev] = b;   // keep the widest fan for this table
  }
  // policy-vs-flow `shape` + the `lead` slice — only on a BIDIRECTIONAL footprint (decompose passes them);
  // single-direction footprints (the oracle fixtures) emit neither, so byte-identical parity is preserved.
  return {
    clusters, tests, noise: [],
    mode: "codebase", selectedSeam, anchor: g.anchor,
    ...(opts.shape ? { shape: opts.shape } : {}), ...(opts.lead ? { lead: opts.lead } : {}),
    resolutionQuality: g.resolution_quality, language: g.language, complete: g.complete,
    seamEdges: [],
    edges: g.resolved_edges().map((e) => ({ from: e.src, to: e.dst, kind: e.kind, provenance: e.provenance, line: to1OrNone(e.line), ...((e as any).op ? { op: (e as any).op } : {}) })),
    seamContracts: _seam_contracts(g, seams),
    blindspots: _blindspots.map((b) => ({ node: b.node, mechanism: b.mechanism, evidence: b.evidence,
      candidates: b.candidates.map((c: any) => ({ symbol: c.symbol ?? c.dst, provenance: c.provenance, ...(c.file ? { file: c.file } : {}) })), ...((b as any).persists ? { persists: true } : {}) })),
    unresolved: g.unresolved,
    ...(_frontier.length ? { frontier: _frontier, frontierCut: _frontierAll.length - _frontier.length } : {}),
    health: health.postures ?? {},
  };
}
