// Auto-anchor selection — the fuzzy entry ramp WITHOUT a manual pick. The deterministic name-overlap
// ranker (anchor_rank) is only a RECALL net: it scores symbols by intent-word overlap, blind to what a
// symbol connects to, so a literally-named-but-isolated symbol ("used in 2 places, links to nothing")
// wins the top slot and, once grown, yields an empty footprint that HIDES the genuinely-wired anchor.
//
// Anchor quality is not a property of the name — it's a property of the FOOTPRINT the anchor produces.
// So we move the decision AFTER a cheap grow: take the top-K name candidates, run a SHALLOW
// grow_to_terminals from each (deterministic, no LLM), and rank by STRUCTURAL facts of the resulting
// footprint — does it REACH terminals (screens / entry points) and crossings (data-flow boundaries), or
// dead-end? This is the structural/semantic split from CLAUDE.md: connectedness is a measured fact
// (deterministic, here); "which footprint is what the user MEANS" is a semantic judgement left to a
// later LLM pass. The degenerate isolated case is killed here, structurally, with no model in the loop.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { from_resolved_graph } from "../../core/graph_ir.js";
import { emit } from "../../core/progress.js";
import { run_pass, available, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { assign_roles, _is_crossing } from "../codebase.js";
import { defs_in_file } from "../scan/def_table.js";

const PASS = registerPass({ tag: "anchor-judge", tier: "strong", note: "pick the entry-point anchor among grown footprints (semantic)" });
import { defs_in_file_treesitter } from "../scan/def_treesitter.js";
import { grow_to_terminals } from "../grow/orchestrate.js";
import { EngineCtx } from "../engine_ctx.js";
import { find_anchor_candidates, rank_anchors, _content_words } from "./anchor_rank.js";
import { expand_intent_terms } from "./intent_expand.js";

// Structural facts of a probed footprint. All deterministic, topology-only (no intent words).
export interface ProbeMetrics {
  nodes: number;       // resolved symbols in the footprint
  reach: number;       // symbols reachable from the anchor (undirected, over resolved + crossing edges)
  degree: number;      // edges incident to the anchor itself
  crossings: number;   // distinct boundary nodes reached across a crossing (data-flow / dispatch / suggested)
  terminals: number;   // terminal endpoints reached (in-degree 0, non-boundary, connected): screens, entry points
  blindspots: number;
  isolated: boolean;   // structurally disqualified — the footprint dead-ends at (or near) the anchor
  terminalLabels: string[];   // sample of the reached endpoints, by complexity (for the LLM judge)
  crossingLabels: string[];   // sample of the reached boundaries, e.g. db tables / routes
}

export interface ProbedAnchor {
  id: string;             // stable handle for the LLM judge (c0, c1, …)
  name: string; file: string; kind: string;
  score: number;          // name-overlap score from rank_anchors (the recall signal)
  terms: string[];        // which intent words matched (explanation)
  metrics: ProbeMetrics | null;   // null = the probe grow failed
  structScore: number;    // the connectedness ranking (reaches-terminals weighted)
  rescued?: boolean;      // was isolated on the cheap (call/import) probe, un-isolated only via data-coupling
  signature?: string;     // the candidate's own declaration line (its CODE identity) — what a reader judges by
  doc?: string;           // its leading doc-comment, the concept the name omits — fed to the judge as MEANING
}

// The data-flow boundary kinds are plumbing, never an "end" of the flow — mirrors _promote_terminals.
const _BOUNDARY = new Set(["table", "route", "resource"]);

// Kinds that are DATA SHAPES, never a flow anchor — an anchor is a symbol that DOES something (a function
// /class/method), not a contract. Dropping these before the probe is a free, safe probe-count cut (embed
// recall surfaces them — e.g. `BugReportRow`, `BugReportsTabProps` were probed for nothing). Structural
// closed-set, not a guess: an interface/type/enum is never the "starting point to read the code from".
const _NON_ANCHOR_KINDS = new Set(["interface", "type", "enum"]);

// Compute the structural facts of a grown footprint. Reuses the SAME primitives the decompose pipeline
// uses (from_resolved_graph + assign_roles + _is_crossing + the terminal filter) so the probe measures
// exactly what the real grow would surface — no parallel heuristic to drift.
export function footprint_metrics(data: any): ProbeMetrics {
  const g = from_resolved_graph(data);
  assign_roles(g);
  const edges = g.resolved_edges();
  const anchorId = g.nodes.has(g.anchor) ? g.anchor : (g.anchors.find((a) => g.nodes.has(a)) ?? g.anchor);

  // undirected reach from the anchor over ALL resolved edges (crossings included — a crossing IS a link)
  const adj = g.adjacency();
  const seen = new Set<string>([anchorId]);
  const stack = [anchorId];
  while (stack.length) for (const nb of adj.get(stack.pop()!) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
  const reach = seen.size;
  const degree = adj.get(anchorId)?.size ?? 0;
  // distinct boundary NODES reached across a crossing — not crossing EDGES (which scale super-linearly
  // with footprint size: a service reading N tables at M call-sites racks up M edges to N nodes). A
  // node count is comparable to `terminals`, so neither metric drowns the other.
  const crossings = new Set(edges.filter(_is_crossing).map((e) => e.dst)).size;

  // terminals = the FAR ends the footprint reaches: in-degree 0 (nothing depends on them), not a
  // boundary node, connected, reachable from the anchor. These are the screens / entry points the
  // user's example wants the anchor to be "linked to".
  const indeg = new Map<string, number>();
  for (const e of edges) if (e.kind !== "contains") indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
  const anchorsSet = new Set(g.anchors.length ? g.anchors : [g.anchor]);
  const terminalNodes = [...g.nodes.values()].filter((n) =>
    !anchorsSet.has(n.id) && (indeg.get(n.id) ?? 0) === 0 && !_BOUNDARY.has(n.kind)
    && (adj.get(n.id)?.size ?? 0) > 0 && seen.has(n.id))
    .sort((a, b) => (b.complexity ?? 0) - (a.complexity ?? 0));
  const terminals = terminalNodes.length;
  const terminalLabels = [...new Set(terminalNodes.map((n) => n.label).filter(Boolean))].slice(0, 8);
  const crossingLabels = [...new Set(edges.filter(_is_crossing).map((e) => g.nodes.get(e.dst)?.label).filter(Boolean) as string[])].slice(0, 8);

  const nodes = g.nodes.size;
  const blindspots = (data.blindspots ?? []).length;
  // disqualified when the footprint dead-ends: only the anchor is reachable, or a tiny footprint that
  // reaches no crossing and no terminal (the "isolated symbol used at 2 places" case).
  const isolated = reach <= 1 || (reach <= 2 && crossings === 0 && terminals === 0);
  return { nodes, reach, degree, crossings, terminals, blindspots, isolated, terminalLabels, crossingLabels };
}

// Reward a footprint that REACHES the ends of a flow (terminals) and crosses boundaries, over one that
// dead-ends. log on reach so a hub's import-fan can't dominate by raw size (the grow's _MOVE_CAP already
// bounds reach ~maxNodes); a small degree term + the name score break ties. This is the connectedness
// ranking — "is it linked to the admin screens?" — NOT a semantic judgement of relevance.
export function struct_score(m: ProbeMetrics | null, nameScore: number): number {
  if (!m || m.isolated) return -1;
  return 3.0 * m.terminals + 2.0 * m.crossings + Math.log2(m.reach + 1) + 0.25 * m.degree + 0.1 * nameScore;
}

// Probe ONE candidate: a shallow, deterministic grow from it, then its footprint facts. Kept small
// (maxNodes/maxSteps) so probing K candidates stays cheap; the full grow runs later on the winner only.
// Pass a shared `ctx` (Lever 2) to build the repo-wide indices ONCE across the whole candidate pool.
export async function probe_anchor(repo: string, file: string, symbol: string,
    opts: { maxNodes?: number; maxSteps?: number; dataCoupling?: boolean; ctx?: EngineCtx } = {}): Promise<ProbeMetrics | null> {
  try {
    const [data] = await grow_to_terminals(repo, file, symbol, {
      maxNodes: opts.maxNodes ?? 30, maxSteps: opts.maxSteps ?? 8,
      bidirectional: true,   // count DOWNSTREAM reach too, so a 0-consumer entry point isn't "isolated"
      dataCoupling: opts.dataCoupling ?? true, dataCouplingLlm: false, ctx: opts.ctx,
    });
    return footprint_metrics(data);
  } catch { return null; }
}

// Look up a candidate's CODE IDENTITY — its declaration line + leading doc-comment — from its own file.
// This is the evidence a human reader actually uses to pick an anchor ("class MissionEngine extends Engine
// — orchestrates weekly mission assignment"), which the topology facts (reach/crossings) throw away. Cheap:
// one file read + a def scan, only for the handful of survivors going to the judge. Prefers the AST
// (tree-sitter) producer so signature+doc work across all five languages — Ruby/C/C++ where the regex
// floor extracts little — and falls back to the TS/JS regex when no grammar/parse is available.
async function _candidate_identity(repo: string, file: string, name: string): Promise<{ signature: string; doc: string } | null> {
  try {
    const root = repo.startsWith("~") ? (process.env.HOME ?? "") + repo.slice(1) : repo;
    const abs = file.startsWith("/") ? file : join(root, file);
    const text = readFileSync(abs, "utf-8");
    const defs = (await defs_in_file_treesitter(file, text)) ?? defs_in_file(file, text);
    const d = defs.find((x) => x.name === name) ?? defs.find((x) => x.enclosing === name);
    return d ? { signature: d.signature, doc: d.doc } : null;
  } catch { return null; }
}

// Phase 2 — the SEMANTIC pick. Structure can rank by connectedness but cannot tell which connected
// footprint is what the user MEANS. The 6-failure thread proved topology FACTS (reach/crossings/cores)
// mis-rank and destabilize the judge — so judge on what a reader judges by: each candidate's own CODE
// (its declaration + doc) plus the surface its footprint is WIRED TO (endpoints). Identity over topology.
// Returns the chosen candidate id, or null if the model is unavailable/unusable (caller falls back).
export function judge_anchor_llm(intent: string, connected: ProbedAnchor[],
    opts: { model?: string; claudeBin?: string | null } = {}): string | null {
  if (connected.length < 2) return connected[0]?.id ?? null;
  const lines = [
    `A developer asks: "${intent}". Choose the single best STARTING POINT in the code to answer it — the`,
    "symbol whose CODE is the mechanism the question is about, not one that merely touches it. For each",
    "candidate you get its declaration (the actual code line) and doc-comment — what it IS — plus the",
    "screens / entry points its footprint is wired to. Judge by what each one IS and DOES, matched to the",
    "question; the name alone can mislead.",
    "",
  ];
  for (const c of connected) {
    const m = c.metrics!;
    const sig = c.signature ? `\n     code: ${c.signature}` : "";
    const dc = c.doc ? `\n     doc: ${c.doc}` : "";
    const ep = m.terminalLabels.length ? `\n     wired to: ${m.terminalLabels.join(", ")}` : "";
    lines.push(`  ${c.id}: ${c.name} (${c.file})${sig}${dc}${ep}`);
  }
  lines.push("",
    "Pick the ONE whose declaration + doc most directly answers the question as the place to start reading.",
    "Prefer the symbol that GOVERNS or DEFINES the mechanism the question is about over a peripheral helper",
    "that only participates in it.",
    'Output ONLY a JSON array, one object per candidate: [{"id":"<candidate id>","best":true|false}]',
    "with `best` true for exactly ONE.");

  let out: Map<string, any>;
  try { out = run_pass(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag }); }
  catch (e) { if (e instanceof LLMError) return null; throw e; }
  // the chosen one = the candidate whose object has best truthy; ignore unknown ids.
  for (const c of connected) {
    const o = out.get(c.id);
    if (o && typeof o === "object" && [true, "true", "True"].includes(o.best)) return c.id;
  }
  return null;
}

// THE entry ramp without a pick: intent → ranked candidates (recall) → shallow probe each → drop the
// structurally-isolated → an LLM judges WHICH connected footprint is the intent's entry point. The
// structural pass is the deterministic floor (kills the bad-anchor-hides-the-result case + an offline
// fallback order); the LLM is the one semantic call (skipped cleanly when no backend). `chosen` is null
// only when NOTHING grew at all. `chosenBy` records which pass decided, for transparency.
export async function select_anchor(repo: string, intent: string,
    opts: { topK?: number; llmExpand?: boolean; expandTerms?: string[]; judge?: boolean; dataCoupling?: boolean; maxNodes?: number; maxSteps?: number; model?: string; claudeBin?: string | null; anchorRecall?: "lexical" | "embed"; seeds?: { name: string; file: string; kind: string }[] } = {}):
    Promise<{ chosen: ProbedAnchor | null; chosenBy: "llm" | "structural" | "none"; noFlow?: boolean; ranked: ProbedAnchor[] }> {
  const topK = opts.topK ?? 8;
  // LLM query-expansion is ON by default here: the deterministic candidate scan is morphological
  // (stem overlap), so it can't bridge "registration"→register / "completion"→complete and silently
  // drops the right symbols at the content pre-filter. The LLM proposing domain vocabulary is the
  // sanctioned meaning-bridge (grounded by the scan: junk terms find nothing); graceful [] offline.
  // expand keywords: use the caller's PRE-COMPUTED terms when given (the CLI runs `expand` concurrently
  // with `entrypoint-select`), else run the pass here (other callers — harness/MCP — stay unchanged).
  const extra = opts.expandTerms ?? ((opts.llmExpand ?? true) ? expand_intent_terms(intent, { model: opts.model, claudeBin: opts.claudeBin }) : []);
  const keywords = [...new Set([..._content_words(intent), ...extra])].sort();
  const cands = find_anchor_candidates(repo, keywords);
  const named = rank_anchors(intent, cands, topK, extra);

  // EMBED RECALL (opt-in, #2 Slice B): union semantic def-table candidates the lexical name-filter can't
  // reach (a path-relevant `save` that shares no stem with the intent). Additive — they probe alongside
  // the lexical pool and earn their rank from the STRUCTURAL probe (structScore), not the name score.
  const probeList = [...named];
  const have = new Set(probeList.map((c) => `${c.name}|${c.file}`));
  // SEED candidates — anchors a STRUCTURAL enumerator surfaced that the NAME-net can't see (an HTTP route
  // handler whose convention name `GET`/`POST`/slug never matches the intent words). They enter the SAME
  // probe→judge funnel as ordinary candidates, NOT as a preemptive override: a seed wins only if its grown
  // footprint best answers the intent (the decide-LAST pattern). Front of the list so the probe-budget
  // slice never drops them; if a seed is the ONLY connected candidate the fallback still anchors on it.
  for (const s of opts.seeds ?? []) {
    const key = `${s.name}|${s.file}`;
    if (!have.has(key)) { have.add(key); probeList.unshift({ name: s.name, file: s.file, kind: s.kind, score: 0, terms: ["~entry"] }); }
  }
  if (opts.anchorRecall === "embed") {
    const { embed_anchor_candidates } = await import("./anchor_embed.js");
    for (const d of await embed_anchor_candidates(repo, intent, { k: topK })) {
      // a METHOD is rarely a standalone anchor — anchor on its enclosing CLASS instead (the lexical recall
      // only ever yields classes/functions, so this keeps the embed pool to the same anchor granularity).
      const name = (d.kind === "method" && d.enclosing) ? d.enclosing : d.name;
      const kind = d.kind === "method" ? "class" : d.kind;
      const key = `${name}|${d.file}`;
      if (!have.has(key)) { have.add(key); probeList.push({ name, file: d.file, kind, score: 0, terms: ["~embed"] }); }
    }
  }
  // drop data-shape candidates (never anchors) BEFORE probing — a free probe-count cut — then bound the budget.
  const toProbe = probeList.filter((c) => !_NON_ANCHOR_KINDS.has(c.kind)).slice(0, 16);

  // TWO-TIER PROBE (Lever 1). The probe's job is to RANK candidates by connectedness and DROP the
  // isolated ones. Data-coupling's carrier-trace overlay DETONATES on hub classes (~100s each on cal.com
  // — measured ~63% of auto-anchor time), yet a candidate already CALL/IMPORT-connected never needs it to
  // look non-isolated. So probe everyone CHEAP (call/import only, no coupling) and pay the coupling overlay
  // ONLY to RESCUE the would-be-isolated — the cross-stack-only anchors (a `$http`→backend route handler
  // with no in-repo caller, coupled only by a shared route/key). Coupling is thus DEMOTED to a SURVIVAL
  // signal (keep the cross-stack anchor in the pool for the judge), not a ranking input — which also keeps
  // the ranking among the connected stable on call/import connectedness (the right probe signal, per the
  // old PERF NOTE). SEAM_PROBE_COUPLING=always restores the probe-everyone-with-coupling path for A/B;
  // =off disables the rescue entirely.
  //
  // Lever 2: ONE shared EngineCtx across the whole pool, so the repo-wide data-coupling grounding index
  // builds ONCE for all rescue probes instead of once per candidate.
  //
  // SEQUENTIAL on purpose — the grow path is not reentrant across `await` (several module/ctx caches);
  // parallelizing was proven to corrupt metrics and shelved as low-ROI. See `probe-parallelism-blocked-on-reentrancy`.
  const alwaysCouple = process.env.SEAM_PROBE_COUPLING === "always";
  const rescueCoupling = !alwaysCouple && (opts.dataCoupling ?? true) && process.env.SEAM_PROBE_COUPLING !== "off";
  const ctx = new EngineCtx();
  const probed: ProbedAnchor[] = [];
  const _pt0 = process.env.SEAM_TIMING ? performance.now() : 0;   // probe-phase wall-clock (opt-in)
  let couplingProbes = 0;
  for (let i = 0; i < toProbe.length; i++) {
    const c = toProbe[i];
    emit(`Probing anchor ${i + 1}/${toProbe.length}: ${c.name}…`);
    if (alwaysCouple) couplingProbes++;
    const metrics = await probe_anchor(repo, c.file, c.name, { dataCoupling: alwaysCouple, maxNodes: opts.maxNodes, maxSteps: opts.maxSteps, ctx });
    probed.push({ id: `c${i}`, name: c.name, file: c.file, kind: c.kind, score: c.score, terms: c.terms ?? [],
      metrics, structScore: struct_score(metrics, c.score) });
  }
  // RESCUE pass — re-probe only the would-be-isolated WITH data-coupling; a candidate that becomes
  // connected (its sole link was a shared key/route) is rescued back into the pool, marked `rescued`.
  if (rescueCoupling) {
    for (const p of probed) {
      if (p.metrics && !p.metrics.isolated) continue;   // already connected the cheap way — never pay coupling
      emit(`Rescue-probing isolated anchor with data-coupling: ${p.name}…`);
      couplingProbes++;
      const m2 = await probe_anchor(repo, p.file, p.name, { dataCoupling: true, maxNodes: opts.maxNodes, maxSteps: opts.maxSteps, ctx });
      if (m2 && !m2.isolated) { p.metrics = m2; p.structScore = struct_score(m2, p.score); p.rescued = true; }
    }
  }
  if (_pt0) process.stderr.write(`[timing] probe phase: ${Math.round(performance.now() - _pt0)}ms for ${toProbe.length} candidates (${couplingProbes} with data-coupling)\n`);

  // RANK: cheaply-connected first (by call/import structScore — never paid coupling), THEN rescued ones
  // (cross-stack-only; ranked among themselves by their coupled structScore, but AFTER the call-connected,
  // since a direct caller is stronger evidence than a shared key). If the probe disqualified everything
  // (e.g. resolver gap), fall back to the full probed list by name so the ramp never empties out.
  const connected = probed.filter((p) => p.metrics && !p.metrics.isolated && !p.rescued)
    .sort((a, b) => b.structScore - a.structScore || b.score - a.score);
  const rescued = probed.filter((p) => p.rescued)
    .sort((a, b) => b.structScore - a.structScore || b.score - a.score);
  const alive = [...connected, ...rescued];
  const pool = alive.length ? alive : [...probed].sort((a, b) => b.score - a.score);
  const dead = probed.filter((p) => !pool.includes(p)).sort((a, b) => b.score - a.score);
  const ranked = [...pool, ...dead];

  let chosen = pool[0] ?? null;
  let chosenBy: "llm" | "structural" | "none" = chosen ? "structural" : "none";
  // the semantic pick — only over the CONNECTED survivors (structure already vetoed the isolated). The LLM
  // commits LAST, judging each candidate by its own CODE (declaration + doc) plus the surface it's wired
  // to — the reader's evidence, not topology counts (which the 6-failure thread proved mis-rank the judge).
  if (chosen && (opts.judge ?? true) && alive.length >= 2 && available(opts.claudeBin)) {
    for (const a of alive) { const id = await _candidate_identity(repo, a.file, a.name); if (id) { a.signature = id.signature; a.doc = id.doc; } }
    emit("Judging which footprint answers the intent…");
    const pick = judge_anchor_llm(intent, alive, { model: opts.model, claudeBin: opts.claudeBin });
    const picked = pick ? alive.find((p) => p.id === pick) : null;
    if (picked) { chosen = picked; chosenBy = "llm"; }
  }
  // no-flow: a chosen footprint that reaches no terminal and crosses no boundary is a computation/strategy
  // unit (polymorphic dispatch / a pure helper), not a traceable flow — there is no spine to find. Report
  // it honestly rather than emit a 1-seam stub. Deterministic, decoupled from which pass picked the anchor.
  const noFlow = !!(chosen?.metrics && chosen.metrics.terminals === 0 && chosen.metrics.crossings === 0);
  // surface the chosen anchor first in the ranked list regardless of which pass picked it.
  return { chosen, chosenBy, noFlow, ranked: chosen ? [chosen, ...ranked.filter((p) => p !== chosen)] : ranked };
}
