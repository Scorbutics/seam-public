// LLM judgement passes: refine the deterministic floor clusters (refine_seams_llm) and tier/name/focus the
// FINAL seams by intent (label_focus_relevance_llm). Both build a prompt, call run_pass, parse the JSON
// verdicts back onto the seams — structure supplies the facts, the model only judges label/tier/culmination.
import { type Graph, type Node, bfsDistance } from "../../core/graph_ir.js";
import { isFlowSubject, isDomainSubject, isProduceEdge } from "../coupling/subjects.js";
import { run_pass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit } from "../../core/progress.js";
import { type Seam, _mk_seam, _sweep_leftovers } from "./clusters.js";
import { _spine_order, _promote_spine_path } from "./spine.js";
import { intersect, maxBy } from "./util.js";

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
  const rep = (s: Seam) => maxBy(s.node_ids.map((i) => g.nodes.get(i)!).filter(Boolean), (n) => n.complexity);
  // PRIORS — hand the model deterministic FACTS so it CONFIRMS the spine rather than reasoning it out
  // (robust on a weak model). The model makes the JUDGEMENT; structure supplies the facts:
  //  • topology: is the seam the ANCHOR, an ENDPOINT (a terminal the flow reaches — in-degree 0, a
  //    screen/entry point) or intermediate plumbing, and its hop-distance from the anchor;
  //  • DOMAIN: which db table(s) it touches — so the model can keep the spine to ONE domain and spot a seam
  //    doing a DIFFERENT entity's work as a side-effect (the case a pure topology read misses, because such
  //    a seam touches the main table too). This is the fact; the relevance verdict stays the model's.
  const indeg = new Map<string, number>();
  for (const e of g.resolved_edges()) if (e.kind !== "contains") indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
  const adj = g.adjacency();
  const dist = bfsDistance(adj, [g.anchor]);
  const subjectNodes = new Map<string, Set<string>>();   // db-table name → node ids that touch it (boundary + direct neighbours)
  for (const n of g.nodes.values()) {
    if (!isDomainSubject(n.kind) || !n.label) continue;
    const set = subjectNodes.get(n.label) ?? subjectNodes.set(n.label, new Set()).get(n.label)!;
    set.add(n.id);
    for (const nb of adj.get(n.id) ?? []) set.add(nb);
  }
  const tablesFor = (s: Seam): string[] => [...subjectNodes].filter(([, nodes]) => s.node_ids.some((i) => nodes.has(i))).map(([t]) => t);
  // FLOOR domain (perf only): the deterministic pre-tier floor needs a notion of "the flow's subject" to
  // decide which far seams are off. subjectNodes is db-tables-only (the prompt's one-domain rule treats
  // routes as transport) — so on a ROUTE-based cross-stack footprint (AngularJS $http ⇄ servlet, no db
  // tables) `domain` was empty and the floor stayed INERT. Give the floor a BROADER subject map over ALL
  // boundary kinds (route/table/event/resource) so it engages there too. Floor-only — does NOT touch the
  // prompt hints or the one-domain judgement, so it can't change tiering quality (it only decides which
  // clearly-off seams skip the LLM, and the floored set stays ⊆ the LLM's "off").
  const floorSubjectNodes = new Map<string, Set<string>>();
  for (const n of g.nodes.values()) {
    if (!isFlowSubject(n.kind) || !n.label) continue;
    const set = floorSubjectNodes.get(n.label) ?? floorSubjectNodes.set(n.label, new Set()).get(n.label)!;
    set.add(n.id);
    for (const nb of adj.get(n.id) ?? []) set.add(nb);
  }
  const floorSubjectsFor = (s: Seam): string[] => [...floorSubjectNodes].filter(([, nodes]) => s.node_ids.some((i) => nodes.has(i))).map(([t]) => t);
  // CULMINATION-GROUNDING FACTS (the priors that fix the "synthetic-referee endpoint crowned the climax"
  // case): a flow CULMINATES where it WRITES its subject (a created/updated record), not at an endpoint
  // that merely reads it. `writesBy` = node → subject tables it PRODUCES (src of a produce-edge into a
  // db-table node); the produce-edge kinds come from the adapter registry (KEY_PRODUCE_EDGE_KINDS), never a
  // hardcoded list. `dirFor` = the seam's grow DIRECTION: backward (a DEPENDENCY / downstream sink — where a
  // generation flow ends) vs forward (a CONSUMER / upstream caller — an entry/admin tool that calls IN).
  const writesBy = new Map<string, Set<string>>();
  for (const e of g.resolved_edges()) {
    if (!isProduceEdge(e.kind)) continue;
    const dst = g.nodes.get(e.dst);
    if (!dst || !isDomainSubject(dst.kind) || !dst.label) continue;
    (writesBy.get(e.src) ?? writesBy.set(e.src, new Set()).get(e.src)!).add(dst.label);
  }
  const writesFor = (s: Seam): string[] => [...new Set(s.node_ids.flatMap((i) => [...(writesBy.get(i) ?? [])]))];
  const dirFor = (s: Seam): "forward" | "backward" | undefined => {
    let f = 0, b = 0;
    for (const i of s.node_ids) { if (i === g.anchor) continue; const d = g.nodes.get(i)?.direction; if (d === "forward") f++; else if (d === "backward") b++; }
    return f === 0 && b === 0 ? undefined : (b >= f ? "backward" : "forward");
  };
  const hintFor = (s: Seam): string => {
    const tables = tablesFor(s);
    const tag = tables.length ? `; tables: ${tables.join(", ")}` : "";
    const writes = writesFor(s);
    const wtag = writes.length ? `; WRITES ${writes.join(", ")}` : "";
    const dir = dirFor(s);
    const dtag = dir === "backward" ? "; downstream" : dir === "forward" ? "; upstream entry" : "";
    const extra = `${tag}${wtag}${dtag}`;
    if (s.node_ids.includes(g.anchor)) return `anchor (start of the flow)${extra}`;
    const d = Math.min(99, ...s.node_ids.map((i) => dist.get(i) ?? 99));
    const endpoint = s.node_ids.some((i) => i !== g.anchor && (indeg.get(i) ?? 0) === 0);
    return `${endpoint ? "ENDPOINT" : "intermediate"}${d < 99 ? `, ${d} hop${d !== 1 ? "s" : ""} from anchor` : ""}${extra}`;
  };
  // DETERMINISTIC PRE-TIER FLOOR (perf — the seam-intent prompt scales with footprint size, the dominant
  // cost). A seam FAR from the anchor that touches NONE of the flow's domain tables, WRITES none of them,
  // and is not an endpoint is STRUCTURALLY a different concern — the prompt's own "one domain" rule applied
  // as a FACT, not a judgement. Pre-mark those "off" and don't spend tokens on them; the anchor, the domain,
  // every endpoint, and all near hops still go to the LLM, which keeps the spine/culmination/supporting
  // JUDGEMENT. Conservative (validated: the floored set ⊆ the LLM's "off" set on a real footprint), and only
  // engages on a sizeable footprint. SEAM_NO_PRETIER disables it (harness A/B).
  const minHop = (s: Seam): number => Math.min(99, ...s.node_ids.map((i) => dist.get(i) ?? 99));
  const isEndpoint = (s: Seam): boolean => s.node_ids.some((i) => i !== g.anchor && (indeg.get(i) ?? 0) === 0);
  const _DOMAIN_HOP = 2, _OFF_HOP = 5;
  const domain = new Set<string>();
  for (const s of ranked) if (minHop(s) <= _DOMAIN_HOP) { for (const t of floorSubjectsFor(s)) domain.add(t); for (const t of writesFor(s)) domain.add(t); }
  const clearlyOff = (s: Seam): boolean => !s.node_ids.includes(g.anchor) && minHop(s) >= _OFF_HOP
    && !isEndpoint(s) && ![...floorSubjectsFor(s), ...writesFor(s)].some((t) => domain.has(t));
  const useFloor = !process.env.SEAM_NO_PRETIER && ranked.length >= 16 && domain.size > 0;
  const floored = new Set<Seam>(useFloor ? ranked.filter(clearlyOff) : []);
  const toJudge = ranked.filter((s) => !floored.has(s));
  if (floored.size) emit(`pre-tier floor: ${floored.size}/${ranked.length} far off-domain seams marked off deterministically (saved from the LLM pass)`);

  const lines = [`A developer is mapping the code that answers: "${intent}".`, "",
    "Here are candidate SEAMS — each a group of related code reached while mapping that question. Each is",
    "tagged [ … ] with deterministic facts: its position in the flow (ANCHOR = the start; ENDPOINT = where",
    "the flow surfaces, a screen / entry point; intermediate = plumbing between), its hop-distance, the",
    "db `tables:` it touches, whether it `WRITES` a subject (produces a record), and its grow direction",
    "(`downstream` = a dependency the flow ends at; `upstream entry` = a consumer/caller that invokes it).",
    "The main path runs anchor → … → the step where the flow's OUTCOME is produced.",
    "For EACH seam decide three things:",
    " - label: 3-6 words naming what this seam DOES (its technical intent — NOT a file or symbol name)",
    " - tier: \"spine\" if it is ON THE MAIN PATH that answers the question — the core flow from the entry",
    "   point through processing to the output/screen the question is about; \"supporting\" if it is needed",
    "   or related but NOT the main flow (auth/session, config, a helper, a secondary lookup); \"off\" if it",
    "   is connected but a DIFFERENT concern — a sibling entity's CRUD or a side-effect, logging, a utility",
    " - culmination: a number 0..1 — how strongly THIS seam is where the flow's main path CULMINATES (its",
    "   OUTCOME): a record WRITTEN to the subject, a job/message dispatched, the final downstream step, or",
    "   the screen that surfaces the result. Give the single best culmination ~1.0, near-misses lower, the",
    "   rest 0. GROUND it on the facts: a seam tagged `WRITES <subject>` or `downstream` is a strong",
    "   culmination; an `ENDPOINT` that is an `upstream entry` (a consumer / admin / test tool that merely",
    "   CALLS INTO the flow) is NOT the culmination even if it touches the subject table — score it ~0.",
    "",
    "Keep the spine to ONE domain: a seam whose `tables:` are a DIFFERENT entity than the main flow's is",
    "doing another domain's work (a side-effect) — make it \"supporting\" even if it ALSO touches the main",
    "table. (Example: on a payments flow, a seam touching `members` is supporting, not spine.)",
    ""];
  for (const s of toJudge) {
    const r = rep(s); if (!r) continue;
    const others = s.node_ids.map((i) => g.nodes.get(i)!).filter((n) => n && n !== r).slice(0, 3).map((n) => n.label).filter(Boolean);
    lines.push(`  ${s.id}: "${s.label}" — ${r.label} (${r.file})${others.length ? "; also " + others.join(", ") : ""}  [${hintFor(s)}]`);
  }
  // OUTPUT FORMAT. seam-intent's latency is OUTPUT-bound (the model writes one object per seam, and the
  // 3-6-word label dominates each). Most seams are "off" and get dimmed/collapsed — they don't need a
  // pretty label. So by default ask only for the seams that MATTER (spine/supporting + the culmination);
  // any seam not listed defaults to "off" and keeps its mechanical label. That cuts the output ~3-5×.
  //  - SEAM_VERBOSE_TIER: per-seam format (every seam, every label) — for A/B / human fidelity.
  // NOTE: dropping the label (an "LLM-first, no-labels" mode) was tried and REJECTED — it systematically
  // degraded the culmination (3/3: the SAVE → a sibling VIEW), because NAMING each seam is reasoning
  // scaffold, not just presentation: forcing the model to say "persist bug report" is what makes it crown
  // the save as the outcome. The ~2.8s saving wasn't worth a wrong answer-of-the-spine.
  const _verbose = !!process.env.SEAM_VERBOSE_TIER;
  if (_verbose) {
    lines.push("", "Default tier=\"supporting\" when unsure; use \"off\" ONLY when clearly a different concern.",
      "Output ONLY a JSON array, one object per seam:",
      '[{"id":"<seam id>","label":"<3-6 words>","tier":"spine|supporting|off","culmination":0..1}]');
  } else {
    lines.push("",
      "Output ONLY a JSON array of the seams that are SPINE or SUPPORTING, plus the single culmination —",
      "one object each. OMIT every other seam: any seam you do NOT list is treated as \"off\" (a different",
      "concern). When unsure whether a seam is supporting or off, LIST it as supporting (don't drop it).",
      '[{"id":"<seam id>","label":"<3-6 words>","tier":"spine|supporting","culmination":0..1}]');
  }

  // This is the dominant cost of an intent run — an LLM pass whose OUTPUT scales with the seam count
  // (one object per seam). Emit it as a phase so the timing summary attributes the time here (not to the
  // fast deterministic grow), making "why is this slow / which step?" answerable from the timing marker.
  emit(`Tiering ${ranked.length} seam(s) by intent (LLM — output-bound, scales with footprint size)…`);
  let out: Map<string, any>;
  try { out = run_pass(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: "seam-intent" }); }
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
      const cx = rep(s)?.complexity ?? 1;
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
