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
import { from_resolved_graph } from "../core/graph_ir.js";
import { emit } from "../core/progress.js";
import { run_pass, available, ClassifierError as LLMError } from "../core/llm.js";
import { assign_roles, _is_crossing } from "./codebase.js";
import { grow_to_terminals } from "./orchestrate.js";
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
}

// The data-flow boundary kinds are plumbing, never an "end" of the flow — mirrors _promote_terminals.
const _BOUNDARY = new Set(["table", "route", "resource"]);

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
export async function probe_anchor(repo: string, file: string, symbol: string,
    opts: { maxNodes?: number; maxSteps?: number; dataCoupling?: boolean } = {}): Promise<ProbeMetrics | null> {
  try {
    const [data] = await grow_to_terminals(repo, file, symbol, {
      maxNodes: opts.maxNodes ?? 30, maxSteps: opts.maxSteps ?? 8,
      bidirectional: true,   // count DOWNSTREAM reach too, so a 0-consumer entry point isn't "isolated"
      dataCoupling: opts.dataCoupling ?? true, dataCouplingLlm: false,
    });
    return footprint_metrics(data);
  } catch { return null; }
}

// Phase 2 — the SEMANTIC pick. Structure can rank by connectedness but cannot tell which connected
// footprint is what the user MEANS: on "how does admin auth work", a data-heavy referrals helper
// out-crosses the actual auth gate, yet the gate (wired to every admin screen) is the right entry
// point. That's a natural-language judgement → the LLM, grounded on the deterministic facts of each
// probed footprint (what it REACHES), never on the symbol name. Returns the chosen candidate id, or
// null if the model is unavailable/unusable (caller falls back to the structural order).
export function judge_anchor_llm(intent: string, connected: ProbedAnchor[],
    opts: { model?: string; claudeBin?: string | null } = {}): string | null {
  if (connected.length < 2) return connected[0]?.id ?? null;
  const lines = [
    `A developer asks: "${intent}". You must choose the single best STARTING POINT in the code to`,
    "answer it — the symbol whose footprint IS the mechanism the question is about, not one that merely",
    "touches it. Below are candidate anchors; each is tagged with deterministic facts about the code",
    "footprint it reaches (reach = symbols connected to it; endpoints = screens/entry points it surfaces;",
    "boundaries = data-flow boundaries like db tables / routes it crosses). Names can mislead — judge by",
    "what each one is WIRED TO.",
    "",
  ];
  for (const c of connected) {
    const m = c.metrics!;
    const ep = m.terminalLabels.length ? `; reaches endpoints: ${m.terminalLabels.join(", ")}` : "";
    const bd = m.crossingLabels.length ? `; crosses boundaries: ${m.crossingLabels.join(", ")}` : "";
    lines.push(`  ${c.id}: ${c.name} (${c.file}) — reach ${m.reach}, ${m.terminals} endpoint(s), ${m.crossings} boundary node(s)${ep}${bd}`);
  }
  lines.push("",
    "Pick the ONE anchor that best answers the question as a starting point to read the code from.",
    "Prefer the anchor that GOVERNS or DEFINES the mechanism and is wired to the relevant surface (the",
    "screens/handlers the question is about) over a peripheral helper that only participates in it.",
    'Output ONLY a JSON array, one object per candidate: [{"id":"<candidate id>","best":true|false}]',
    "with `best` true for exactly ONE.");

  let out: Map<string, any>;
  try { out = run_pass(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: "anchor-judge" }); }
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
    opts: { topK?: number; llmExpand?: boolean; judge?: boolean; dataCoupling?: boolean; maxNodes?: number; maxSteps?: number; model?: string; claudeBin?: string | null } = {}):
    Promise<{ chosen: ProbedAnchor | null; chosenBy: "llm" | "structural" | "none"; ranked: ProbedAnchor[] }> {
  const topK = opts.topK ?? 8;
  // LLM query-expansion is ON by default here: the deterministic candidate scan is morphological
  // (stem overlap), so it can't bridge "registration"→register / "completion"→complete and silently
  // drops the right symbols at the content pre-filter. The LLM proposing domain vocabulary is the
  // sanctioned meaning-bridge (grounded by the scan: junk terms find nothing); graceful [] offline.
  const extra = (opts.llmExpand ?? true) ? expand_intent_terms(intent, { model: opts.model, claudeBin: opts.claudeBin }) : [];
  const keywords = [...new Set([..._content_words(intent), ...extra])].sort();
  const cands = find_anchor_candidates(repo, keywords);
  const named = rank_anchors(intent, cands, topK, extra);

  const probed: ProbedAnchor[] = [];
  for (let i = 0; i < named.length; i++) {
    const c = named[i];
    emit(`Probing anchor ${i + 1}/${named.length}: ${c.name}…`);
    const metrics = await probe_anchor(repo, c.file, c.name, { dataCoupling: opts.dataCoupling, maxNodes: opts.maxNodes, maxSteps: opts.maxSteps });
    probed.push({ id: `c${i}`, name: c.name, file: c.file, kind: c.kind, score: c.score, terms: c.terms ?? [],
      metrics, structScore: struct_score(metrics, c.score) });
  }

  // keep the connected candidates; if the probe disqualified everything (e.g. resolver gap), fall back
  // to the full probed list ranked by name so the ramp never empties out.
  const alive = probed.filter((p) => p.metrics && !p.metrics.isolated);
  const pool = alive.length ? alive : probed;
  pool.sort((a, b) => b.structScore - a.structScore || b.score - a.score);
  const dead = probed.filter((p) => !pool.includes(p)).sort((a, b) => b.score - a.score);
  const ranked = [...pool, ...dead];

  let chosen = pool[0] ?? null;
  let chosenBy: "llm" | "structural" | "none" = chosen ? "structural" : "none";
  // the semantic pick — only over the CONNECTED survivors (structure already vetoed the isolated).
  if (chosen && (opts.judge ?? true) && alive.length >= 2 && available(opts.claudeBin)) {
    emit("Judging which footprint answers the intent…");
    const pick = judge_anchor_llm(intent, alive, { model: opts.model, claudeBin: opts.claudeBin });
    const picked = pick ? alive.find((p) => p.id === pick) : null;
    if (picked) { chosen = picked; chosenBy = "llm"; }
  }
  // surface the chosen anchor first in the ranked list regardless of which pass picked it.
  return { chosen, chosenBy, ranked: chosen ? [chosen, ...ranked.filter((p) => p !== chosen)] : ranked };
}
