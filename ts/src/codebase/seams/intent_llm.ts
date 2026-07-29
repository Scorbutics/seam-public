// LLM judgement passes: refine the deterministic floor clusters (refine_seams_llm) and tier/name/focus the
// FINAL seams by intent (label_focus_relevance_llm). Both build a prompt, call run_pass, parse the JSON
// verdicts back onto the seams — structure supplies the facts, the model only judges label/tier/culmination.
import { type Graph, type Node, bfsDistance } from "../../core/graph_ir.js";
import { debugOn } from "../../core/progress.js";
import { isFlowSubject, isDomainSubject, isProduceEdge } from "../coupling/subjects.js";
import { run_pass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit } from "../../core/progress.js";
import { type Seam, _mk_seam, _sweep_leftovers } from "./clusters.js";
import { _spine_order, _promote_spine_path } from "./spine.js";
import { intersect, maxBy } from "./util.js";
import { core, toWire, seamsToCore } from "./wire.js";

// Build a prompt for the LLM to refine the seam clusters based on the members, their floor grouping, and their usage by consumers.
// The prompt instructs the LLM to group members into technical-intent seams and name each intent, while also considering the user's intent if provided.
function _build_refine_prompt(g: Graph, members: Node[], floorOf: Map<string, string>, uses: Map<string, string[]>, intent?: string): string {
  const anchorSym = g.nodes.has(g.anchor) ? g.nodes.get(g.anchor)!.label : g.anchor;
  const lines = [
    `A code symbol \`${anchorSym}\` has these MEMBERS (carriers). Group them into technical-intent`,
    "SEAMS (one or more members that serve the same purpose) and NAME each intent (3-6 words).",
    "A deterministic FLOOR grouping is given as a starting point — keep it unless the big picture",
    "says merge or split. Use ONLY the member ids listed; invent nothing.",
    "",
    "MEMBERS (id [floor-group]: symbol):",
  ];
  for (const m of members) lines.push(`  ${m.id} [${floorOf.get(m.id) ?? "?"}]: ${m.label}`);
  lines.push("\nCONSUMERS (who uses which members — members used together suggest one intent):");
  for (const [cid, used] of uses) if (used.length) lines.push(`  ${g.nodes.get(cid)!.label} → ${used.join(", ")}`);
  if (intent) {
    lines.push(`\nThe user is asking: "${intent}". On the members of the ONE seam that best answers that question, set "match": true (leave it false/absent on all others).`);
    lines.push("\nOutput ONLY a JSON array, one object per MEMBER:");
    lines.push('[{"id":"<member id>","seam":"S1","label":"<intent name>","match":false}]');
  } else {
    lines.push("\nOutput ONLY a JSON array, one object per MEMBER:");
    lines.push('[{"id":"<member id>","seam":"S1","label":"<intent name>"}]');
  }
  return lines.join("\n");
}

// Refine the seam clusters using an LLM based on the members, their floor grouping, and their usage by consumers.
export function refine_seams_llm(g: Graph, floorSeams: Seam[], opts: { intent?: string; model?: string; claudeBin?: string | null } = {}): Seam[] {
  const anchor = g.anchor;
  const anchorNode = g.nodes.get(anchor);
  if (!anchorNode) return floorSeams;
  const members = [...g.nodes.values()].filter((n) => n.role === "core" && n.id !== anchor && n.enclosing === anchorNode.label);
  if (members.length < 2) return floorSeams;
  const consumers = [...g.nodes.values()].filter((n) => n.role === "link");
  const adj = g.adjacency();
  const cset = new Set(members.map((m) => m.id));
  const uses = new Map<string, string[]>(consumers.map((c) => [c.id, [...intersect(cset, adj.get(c.id) ?? new Set())].sort()]));
  const floorOf = new Map<string, string>();
  for (const s of floorSeams) for (const nid of s.node_ids) if (cset.has(nid)) floorOf.set(nid, s.id);

  emit("Refining seam clusters (LLM)…");
  let out: Map<string, any>;
  try { out = run_pass(_build_refine_prompt(g, members, floorOf, uses, opts.intent), { model: opts.model, claudeBin: opts.claudeBin, tag: "seam-refine" }); }
  catch (e) { if (e instanceof LLMError) return floorSeams; throw e; }

  const grouping = new Map<string, string>();
  const labels = new Map<string, string>();
  const matchVotes = new Map<string, number>();
  for (const [cid, obj] of out) {
    if (cset.has(cid) && obj && typeof obj === "object") {
      const sk = String(obj.seam ?? "").trim();
      if (sk) {
        grouping.set(cid, sk);
        const lab = String(obj.label ?? "").trim();
        if (lab && !labels.has(sk)) labels.set(sk, lab);
        if (opts.intent && [true, "true", "True", 1].includes(obj.match)) matchVotes.set(sk, (matchVotes.get(sk) ?? 0) + 1);
      }
    }
  }
  if (!grouping.size) return floorSeams;
  for (const m of members) if (!grouping.has(m.id)) grouping.set(m.id, floorOf.get(m.id) ?? m.id);
  let selectedSk: string | null = null, best = -1;
  for (const [sk, v] of matchVotes) if (v > best) { best = v; selectedSk = sk; }

  const bySeam = new Map<string, string[]>();
  for (const [cid, sk] of grouping) { if (!bySeam.has(sk)) bySeam.set(sk, []); bySeam.get(sk)!.push(cid); }
  const seams: Seam[] = [];
  for (const [sk, cids] of bySeam) {
    const cs = new Set(cids);
    const cons = consumers.filter((c) => intersect(cs, new Set(uses.get(c.id))).size).map((c) => c.id);
    const rep = maxBy(cids.map((c) => g.nodes.get(c)!), (n) => n.complexity);
    const seam = _mk_seam(rep.id, labels.get(sk) || rep.label, [anchor, ...[...cids].sort(), ...cons], false, "llm");
    if (sk === selectedSk) seam.selected = true;
    seams.push(seam);
  }
  return _sweep_leftovers(g, seams);
}

// One intent-aware pass over the FINAL seams — INCLUDING the grown-consumer and data-coupling seams
// that refine_seams_llm (intra-anchor members only) and mark_relevance_llm (link nodes only) never
// reach for a function anchor. Per seam it (1) NAMES the technical intent in 3-6 words (replacing the
// mechanical floor label = a raw table/handler symbol), (2) marks a seam INCIDENTAL when it's coupled
// but a different concern (a sibling entity's CRUD bundled on the same page) so the default view dims
// it without dropping it, and (3) votes the single seam that best ANSWERS the question into focus.
// Supersedes the link-only mark_relevance_llm — one run_pass call, so the generation stays ceiling-safe.
export function label_focus_relevance_llm(g: Graph, seams: Seam[], intent: string,
    opts: { model?: string; claudeBin?: string | null; promoteSpinePath?: boolean } = {}): void {
  // Include SUGGESTED seams — in codebase mode those ARE the grown-consumer + data-coupling crossing
  // seams (reached only via SUGGESTED edges), exactly the ones carrying mechanical labels and the most
  // likely to be off-intent. Excluding them is what left `members`/`GET`/`POST` unnamed and undimmed.
  const ranked = seams.filter((s) => s.node_ids.length);
  // A tiny footprint (one seam) has nothing to TIER — but leaving it untiered renders as a blank map
  // with no spine/answer. It IS the whole answer, so floor it as the spine seam deterministically
  // rather than asking the LLM to rank one thing against nothing.
  if (ranked.length < 2) { if (ranked.length === 1) { ranked[0].tier = "spine"; ranked[0].selected = true; } return; }
  // THE DETERMINISTIC HALF IS THE CORE'S. The priors (hop distance, endpoint-ness, the subject tables a
  // seam touches, which it WRITES, its grow direction), the pre-tier floor, and the prompt text are built by
  // `seam_decompose::intent` — see rust/parity/intent_prompt.ts, which compares the assembled prompt
  // byte-for-byte against what this function used to produce.
  //
  // ONLY THE TRANSPORT STAYS HERE. The core's host bus is record-and-replay, not a callback: the JS thread
  // is blocked inside the synchronous napi call, so a pass owned by the core cannot call back out to serve a
  // prompt without deadlocking. Moving `run_pass` across would mean making the whole decompose pipeline
  // re-runnable across bus rounds — a design decision, not a port. So: facts there, model call here.
  const _p = JSON.parse(core().decomposeIntentPrompt(
    toWire(g), seamsToCore(ranked), intent, debugOn("tierprompt"), false));
  // The facts come back STRUCTURED as well as rendered, and the verdict loop below uses those rather than
  // re-deriving them on this side — a second derivation is the drift this port exists to remove.
  const _facts = new Map<string, { writes: string[]; dir?: "forward" | "backward"; repComplexity: number }>(
    (_p.facts ?? []).map((f: any) => [f.id, { writes: f.writes ?? [], dir: f.dir ?? undefined, repComplexity: f.repComplexity ?? 1 }]));
  const writesFor = (s: Seam): string[] => _facts.get(s.id)?.writes ?? [];
  const dirFor = (s: Seam): "forward" | "backward" | undefined => _facts.get(s.id)?.dir;
  const repCx = (s: Seam): number => _facts.get(s.id)?.repComplexity ?? 1;
  const floored = new Set<Seam>(ranked.filter((s) => (_p.floored ?? []).includes(s.id)));
  if (floored.size) emit(`pre-tier floor: ${floored.size}/${ranked.length} far off-domain seams marked off deterministically (saved from the LLM pass)`);
  const _verbose = debugOn("tierprompt");

  emit(`Tiering ${ranked.length} seam(s) by intent (LLM — output-bound, scales with footprint size)…`);
  let out: Map<string, any>;
  try { out = run_pass(_p.prompt, { model: opts.model, claudeBin: opts.claudeBin, tag: "seam-intent" }); }
  catch (e) { if (e instanceof LLMError) return; throw e; }

  // Relabel + tier each seam; rank the CULMINATION (the model's verdict, grounded on the WRITES/downstream
  // facts we fed it) and pick the strongest as the answer. `culmination` is a 0..1 confidence; we also
  // accept the legacy boolean `answers` (true→1) so older callers/mocks keep working. The per-seam score +
  // the grounding facts (writes/dir) are RETAINED on the seam for the LLM-context projection's ranked climax
  // — the fragile single-★ pick stays the model's call, we just stop throwing the ranking away.
  const tierMap = new Map<string, "spine" | "supporting" | "off">();
  // floored seams never reached the LLM → seed them "off" (else the post-loop's default would make them
  // "supporting"). They keep their existing mechanical label and get culmination 0; they're dimmed below.
  for (const s of floored) { tierMap.set(s.id, "off"); s.culmination = 0; }
  let answer: { id: string; score: number; cx: number } | null = null;
  const num = (v: any): number => typeof v === "number" ? v
    : [true, "true", "True", 1].includes(v) ? 1
    : (typeof v === "string" && v.trim() !== "" && !isNaN(+v)) ? +v : 0;
  for (const s of ranked) {
    const o = out.get(s.id);
    if (!o || typeof o !== "object") continue;
    const lab = String(o.label ?? "").trim();
    if (lab) s.label = lab;
    const t = String(o.tier ?? "").trim().toLowerCase();
    tierMap.set(s.id, t === "spine" ? "spine" : t === "off" ? "off" : "supporting");
    const c = Math.max(0, Math.min(1, num(o.culmination ?? o.answers)));
    const writes = writesFor(s), dir = dirFor(s);
    s.culmination = c; if (writes.length) s.writes = writes; if (dir) s.dir = dir;
    if (c > 0) {
      const cx = repCx(s);
      if (!answer || c > answer.score || (c === answer.score && cx > answer.cx)) answer = { id: s.id, score: c, cx };
    }
  }
  // The anchor's OWN seam and the answer seam are, by definition, the two ends of the main path.
  const anchorSeamId = seams.find((s) => s.node_ids.includes(g.anchor))?.id;
  if (anchorSeamId) tierMap.set(anchorSeamId, "spine");
  if (answer) tierMap.set(answer.id, "spine");
  // a seam the LLM didn't return: in terse mode that means "off" (it listed only spine/supporting); in
  // verbose mode the LLM tiered every seam, so a gap is an "unsure" → the documented supporting default.
  const _unlistedTier = _verbose ? "supporting" : "off";
  for (const s of ranked) s.tier = tierMap.get(s.id) ?? _unlistedTier;
  // A backend flow (webhook/cron/worker) may have no UI terminal, so the LLM marks no `answers` seam —
  // but a coherent flow still CULMINATES. Fall back to the FAR END of the spine (the spine seam furthest
  // from the anchor, by the same BFS trace that orders the spine): topology only, language-agnostic.
  if (!answer) {
    const order = _spine_order(g, ranked);
    const farId = order[order.length - 1];
    if (farId && farId !== anchorSeamId) answer = { id: farId, score: 0, cx: 0 };
  }
  // STEP 2 (opt-in): promote SUPPORTING seams that sit structurally ON the path between the two confirmed
  // spine endpoints (anchor seam → culmination seam) up to `spine`. A seam on the shortest seam-path
  // between anchor and outcome IS the main path — even if the model, keying on the anchor's single table,
  // demoted it as "another domain" (the case a COMPUTE table buries: pair_weights on a weekly_tasks flow).
  if (opts.promoteSpinePath && anchorSeamId && answer && answer.id !== anchorSeamId) {
    _promote_spine_path(g, ranked, anchorSeamId, answer.id);
  }
  // Dim OFF-intent seams (keep visible) — but never dim a node that ALSO lives in a non-off seam.
  const keep = new Set<string>();
  for (const s of ranked) if (s.tier !== "off") for (const nid of s.node_ids) keep.add(nid);
  for (const s of ranked) if (s.tier === "off") for (const nid of s.node_ids) {
    if (keep.has(nid)) continue;
    const n = g.nodes.get(nid); if (n) n.relevant = false;
  }
  if (answer) for (const s of seams) s.selected = s.id === answer.id;
}
