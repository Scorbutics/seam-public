// Port of src/codebase/orchestrate.py — P5 LLM-directional auto-orchestration: GROW a footprint
// toward answering a question. Seed from a confirmed anchor, then LOOP: show the LLM the current
// footprint + the question, let it pick ONE node and a DIRECTION (up = consumers / down = deps) that
// advances toward the answer, expand+merge, repeat — until done or a step budget. The LLM only
// CHOOSES moves over the deterministic primitives; it never invents an edge.
import { run_pass, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit, dbg } from "../../core/progress.js";

const PASS = registerPass({ tag: "orchestrate", tier: "cheap", note: "auto-grow move picker (node + direction per step)" });
import { from_resolved_graph } from "../../core/graph_ir.js";
import { assign_roles, _is_crossing } from "../codebase.js";
import { _key, merge_resolved } from "../scan/expand.js";
import { build_footprint } from "../scan/index.js";
import { makeIntentKeyRanker } from "./key_ranker.js";
import { embedScoreDefs } from "../scan/def_embed.js";
import { normpath } from "../../core/resolve/walk.js";
import { isTestFile, } from "../../core/resolve/consumers.js";
import { isFlowSubject, isHandlerEdge, resolveCoupling } from "../coupling/index.js";
import { _read } from "../scan/ast_units.js";
import { _annotationLo, _chain_route_consumers } from "../scan/attach.js";
import { EngineCtx } from "../engine_ctx.js";
import { GROW } from "./config.js";

// ── COUPLING as a SEPARATE OVERLAY (decoupled from the grow traversal) ───────────────────────────────────
// The grow used to run data-coupling INSIDE every per-node build_footprint, so each expansion re-coupled its
// new node → the complements became frontier candidates → the grow re-anchored them → coupling ran again: a
// compounding loop, with the coupling crossings, intent, fan-in and direction all fighting in ONE frontier.
// Now the grow TRAVERSAL is purely structural (consumers/deps + intent) and coupling is computed ONCE on the
// anchor and merged onto the SETTLED footprint — a bridge over a finished map, never an ingredient of it. The
// two subsystems can now be judged and fixed in isolation. Mirrors the old consumers_graph invocation.
async function _anchorCouplingDelta(repo: string, anchorFile: string, data: any, opts: any, ctx: EngineCtx): Promise<{ nodes: any[]; edges: any[]; blindspots: any[]; counter: number }> {
  const empty = { nodes: [], edges: [], blindspots: [], counter: 0 };
  const ar = _read(repo, anchorFile);
  if (!ar) return empty;
  // the REAL anchor id (a class anchor is keyed by its name, not "n1") so the bridge edges attach to the
  // footprint's anchor node and stay reachable — not orphaned.
  const anchorId = data.anchor?.id ?? "n1";
  const arange: number[] = data.anchor?.range ?? [0, 0];
  const resolved = arange[1] > 0;                                  // a real def span vs a name-only anchor (whole file)
  const keyLo = resolved ? _annotationLo(ar[0], arange[0]) : 0;
  const keyHi = resolved ? arange[1] : (ar[0].match(/\n/g) ?? []).length;
  const delta = await resolveCoupling(repo, anchorId, anchorFile, ar[0], keyLo, keyHi, (data.nodes ?? []).length, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, ctx);
  delta.counter = await _chain_route_consumers(repo, delta.nodes, delta.edges, delta.counter);   // route → its consumers (2nd hop), as before
  return delta;
}

// Couple ONE reached node's whole file, attaching the bridge to that node. The anchor coupling above is span-
// precise; this fans coupling over the OTHER boundary-bearing files the seed reached — a HUB anchor
// (`getBookingService`, no boundary of its own) reaches RESOURCES whose @Path routes must still cross to their
// consumers. Whole-file (not the node's span) so EVERY handler in the resource crosses, not just one op. The
// resolveCoupling gate skips a file with no boundary cheaply, so this is bounded to the few real boundaries.
async function _fileCouplingDelta(repo: string, file: string, anchorId: string, counter: number, opts: any, ctx: EngineCtx): Promise<{ nodes: any[]; edges: any[]; blindspots: any[]; counter: number }> {
  const empty = { nodes: [], edges: [], blindspots: [], counter };
  const ar = _read(repo, file);
  if (!ar) return empty;
  const hi = (ar[0].match(/\n/g) ?? []).length;
  const delta = await resolveCoupling(repo, anchorId, file, ar[0], 0, hi, counter, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, ctx);
  delta.counter = await _chain_route_consumers(repo, delta.nodes, delta.edges, delta.counter);
  return delta;
}

// Merge the coupling overlay onto the settled footprint. Re-id any complement that would collide with a
// structural node id (the grow assigned its own ids while the overlay was held aside); the anchor `n1` and the
// overlay's internal references stay consistent through the remap.
function _mergeCouplingOverlay(data: any, overlay: { nodes: any[]; edges: any[]; blindspots: any[] }): void {
  if (!overlay?.nodes?.length) return;
  const used = new Set<string>((data.nodes ?? []).map((n: any) => n.id));
  const remap = new Map<string, string>();
  let k = (data.nodes ?? []).length;
  for (const n of overlay.nodes) {
    let id = n.id;
    while (used.has(id)) id = `dc${k++}`;
    if (id !== n.id) remap.set(n.id, id);
    used.add(id); data.nodes.push({ ...n, id });
  }
  for (const e of overlay.edges) data.edges.push({ ...e, from: remap.get(e.from) ?? e.from, to: remap.get(e.to) ?? e.to });
  (data.blindspots ??= []).push(...(overlay.blindspots ?? []));
}

// The current footprint as {id, symbol, role, file, crossing} — deterministic roles only (fast, no
// LLM). `crossing` flags a node reached across a heuristic boundary: the frontier the LLM should
// rank + prefer following.
export function _summary(data: any): any[] {
  const g = from_resolved_graph(data);
  assign_roles(g);
  const crossings = new Set<string>();
  for (const e of g.resolved_edges()) if (_is_crossing(e)) crossings.add(e.dst);
  return [...g.nodes.values()].map((n: any) => ({
    id: n.id, symbol: n.label, role: n.role, file: n.file, crossing: crossings.has(n.id),
  }));
}

// `expanded` holds the moves already followed, keyed `${symbol} ${up|down}`. Annotating them in
// the prompt stops the LLM re-picking a node+direction that can only yield what's already on screen
// (the dominant wasted move: re-expanding the anchor, whose consumers the seed already pulled in).
export function _step_prompt(intent: string, summary: any[], expanded: Set<string> = new Set()): string {
  const lines = [
    `A developer asks: "${intent}". You are GROWING a code footprint to answer it.`,
    "",
    "Current footprint (symbol — role — file):",
  ];
  let has_crossing = false;
  let has_expanded = false;
  for (const n of summary.slice(0, 45)) {
    const tag = n.crossing ? "   ⤳ SUGGESTED CROSSING" : "";
    has_crossing = has_crossing || Boolean(n.crossing);
    const up = expanded.has(`${n.symbol} up`), down = expanded.has(`${n.symbol} down`);
    const exp = up && down ? "   [already expanded up+down]" : up ? "   [already expanded up]" : down ? "   [already expanded down]" : "";
    has_expanded = has_expanded || Boolean(exp);
    lines.push(`  ${n.symbol} — ${n.role} — ${n.file}${tag}${exp}`);
  }
  lines.push(
    "",
    "Pick ONE node to expand toward the answer, and a DIRECTION:",
    "  up   = its CONSUMERS (who uses it: callers, controllers, handlers, tests)",
    "  down = its DEPENDENCIES (what it uses: services, repositories, db)",
    "Pick the single move that best advances toward answering the question. Prefer nodes whose",
    "role/area is on the path to the answer. Set done=true once the footprint already covers the",
    "answer — do NOT over-expand.",
  );
  if (has_expanded) {
    lines.push(
      "",
      "A node marked [already expanded …] has had that direction FULLY followed — picking that same",
      "node+direction again yields NOTHING new. Pick a DIFFERENT node, or a direction not yet expanded",
      "(e.g. a freshly-added consumer's own consumers), or set done=true if the footprint already answers.",
    );
  }
  if (has_crossing) {
    lines.push(
      "",
      "A ⤳ SUGGESTED CROSSING is the OTHER SIDE of a boundary the chain reached by heuristic — a",
      "string-dispatch to an edge function, an HTTP route, a job/queue handler. That is OFTEN where",
      "the real work happens. If a crossing is on the path to the answer, PREFER expanding it (down)",
      "over staying on the near side — following it is exactly how the chain reaches the processing.",
    );
  }
  lines.push(
    "",
    'Output ONLY a JSON array with exactly ONE object (use a symbol from the list verbatim):',
    '[{"id":"step","node":"<symbol>","direction":"up|down","done":false}]',
  );
  return lines.join("\n");
}

const _MOVE_CAP = GROW.moveCap;   // a single move adding more than this is "too broad" (a widely-used class) → skipped

// Seed from the anchor, then let the LLM grow the footprint toward `intent` for up to `maxSteps`.
// Returns [the grown ResolvedGraph, the move history]. A move that would add more than `_MOVE_CAP`
// nodes is SKIPPED — it floods the footprint instead of advancing the answer. Degrades to whatever
// it has grown if the LLM is unavailable / unusable.
export async function auto_orchestrate(repo: string, anchorFile: string, symbol: string, intent: string,
    opts: { maxSteps?: number; model?: string; claudeBin?: string | null; dataCoupling?: boolean; dataCouplingLlm?: boolean } = {}): Promise<[any, any[]]> {
  const maxSteps = opts.maxSteps ?? 4;
  const model = opts.model ?? "claude-haiku-4-5";
  const dataCoupling = opts.dataCoupling, dataCouplingLlm = opts.dataCouplingLlm, claudeBin = opts.claudeBin;
  const ctx = new EngineCtx();   // ONE cache context shared across every grow move (repo indices built once, not per move)
  let data: any = await build_footprint(repo, anchorFile, symbol, { dataCoupling, dataCouplingLlm, model, claudeBin, ctx });
  const history: any[] = [];
  // Moves already followed, keyed `${symbol} ${up|down}`. The seed = build_footprint already
  // expanded the ANCHOR's consumers, so its `up` starts expanded (re-picking it was the #1 wasted
  // move). A no-op move no longer ends the grow — we skip it and bail only once genuinely stuck, so
  // one bad pick can't strand the footprint short of the answer.
  const expanded = new Set<string>([`${symbol} up`]);
  const MAX_CONSEC_NOOP = GROW.maxConsecNoop;
  let consecNoop = 0;
  for (let _step = 0; _step < maxSteps; _step++) {
    emit(`Growing the footprint with the LLM (step ${_step + 1}/${maxSteps})…`);
    const summary = _summary(data);
    let out: Map<string, any>;
    try { out = run_pass(_step_prompt(intent, summary, expanded), { model, claudeBin: opts.claudeBin, tag: PASS.tag }); }
    catch (e) { if (e instanceof LLMError) break; throw e; }
    let dec: any = out.get("step");
    if (dec === undefined) for (const v of out.values()) { if (v && typeof v === "object") { dec = v; break; } }
    if (!dec || typeof dec !== "object" || [true, "true", "True"].includes(dec.done)) break;
    let node_sym = String(dec.node ?? "").trim();
    let direction = String(dec.direction ?? "up").trim().toLowerCase().startsWith("d") ? "down" : "up";
    let chosen = summary.find((n) => n.symbol === node_sym);
    if (!chosen) break;
    let moveKey = `${node_sym} ${direction}`;
    let auto = false;
    // The LLM re-picked an already-followed move (a guaranteed no-op — weak models fixate on the
    // anchor even when it's marked expanded). Rather than waste the step or stall, ADVANCE THE
    // FRONTIER deterministically: climb the nearest not-yet-expanded consumer (up), toward the
    // controller/handler/entrypoint that answers "how is X created". Only when no frontier remains
    // is the grow genuinely stuck — then skip and bail after MAX_CONSEC_NOOP.
    if (expanded.has(moveKey)) {
      const fb = summary.find((n) => n.role !== "core" && !expanded.has(`${n.symbol} up`));
      if (!fb) {
        history.push({ node: node_sym, direction, added: 0, skipped: "already expanded" });
        if (++consecNoop >= MAX_CONSEC_NOOP) break;
        continue;
      }
      chosen = fb; node_sym = fb.symbol; direction = "up"; moveKey = `${fb.symbol} up`; auto = true;
    }
    expanded.add(moveKey);
    const nd = data.nodes.find((x: any) => x.id === chosen.id);
    if (!nd) break;
    const line = (nd.range ?? [0])[0];
    let add: any;
    try {
      add = await build_footprint(repo, nd.file, nd.symbol, { direction: direction === "down" ? "down" : "up", anchorLine: line, dataCoupling, dataCouplingLlm, model, claudeBin, ctx });
    } catch { break; }
    // a move that would flood the footprint (a widely-used class' consumers) doesn't advance the
    // answer — skip it and let the LLM try elsewhere, rather than drowning the intent in noise.
    const have = new Set(data.nodes.map((x: any) => _key(x)));
    // _MOVE_CAP guards against a widely-used class' import fan flooding the footprint. Data-coupling
    // nodes (table/route boundaries + their capped readers/handlers + the one-hop UI chain) are already
    // self-bounded by READER_CAP and are the intent ("…and where is it displayed?"), so don't count them.
    const new_nodes = add.nodes.filter((n: any) => !have.has(_key(n)) && !n.coupling).length;
    if (new_nodes > _MOVE_CAP) {
      history.push({ node: node_sym, direction, added: 0, skipped: `too broad (+${new_nodes})`, ...(auto ? { auto: true } : {}) });
      if (++consecNoop >= MAX_CONSEC_NOOP) break;
      continue;
    }
    const before = data.nodes.length;
    // the expanded node becomes a core; DOWN deps ride in as links adjacent to it.
    data = merge_resolved(data, add, add.anchor?.id);
    const added = data.nodes.length - before;
    history.push({ node: node_sym, direction, added, ...(auto ? { auto: true } : {}) });
    // a dead-end for THIS node+direction (now marked expanded) — don't end the whole grow on it; let
    // the LLM try a different node, stopping only once it's stuck for MAX_CONSEC_NOOP moves running.
    if (added === 0) { if (++consecNoop >= MAX_CONSEC_NOOP) break; continue; }
    consecNoop = 0;
  }
  return [data, history];
}

// #1 — DETERMINISTIC grow (no LLM). The LLM move-picker only ever tried to follow the resolved CROSSINGS
// (data-coupling boundaries, string-dispatch, suggested edges) outward to the footprint's terminals — and
// did it unreliably (it fixates on the anchor; the deterministic frontier-fallback caught it live). So
// follow them directly: each step re-anchor on the most promising unexpanded frontier node — a
// crossing-reached one first (that's the chain toward the terminals), else the largest consumer — letting
// the transitive data-coupling chain extend reach. Bounded by steps + a per-move flood cap + a node budget.
// Reproducible, offline, no orchestrate LLM passes. The intent TIER pass then prunes which terminals matter:
// Pick the next frontier node to expand. P2 discovers for CONNECTIVITY (docs/grow-architecture.md): a CROSSING
// (a data-flow edge toward the terminals) is followed FIRST, so the spine is always traced and a high-intent
// terminal sitting behind a LOW-intent transit is never starved out of the budget — the pathfinding failure
// intent-first caused. Intent is a SECONDARY guide: it orders among equally-connected candidates but can NEVER
// prune a crossing (so a transit is safe). The off-intent HUB fan that briefly justified intent-first is now
// capped in P3 (the coupling overlay), not refereed here; AUTHORITATIVE intent ranking is P4 (decompose tiers
// spine/supporting/off). No relevance signal (offline / no --intent → iscore≡0) → crossings-then-complexity.
export function _nextFrontier<T extends { id: string; complexity?: number }>(
  cand: T[], crossings: Set<string>, iscore: (n: T) => number, typeRefOnly: Set<string> = new Set()): T | undefined {
  return [...cand].sort((a, b) =>
    (Number(crossings.has(b.id)) - Number(crossings.has(a.id)))     // (1) CONNECTIVITY — crossings toward terminals
    || (Number(!typeRefOnly.has(b.id)) - Number(!typeRefOnly.has(a.id)))  // (2) DELEGATION (calls) before payload type-refs
    || (iscore(b) - iscore(a))                                      // (3) intent — a guide/tiebreak, never prunes a crossing
    || ((b.complexity ?? 0) - (a.complexity ?? 0)))[0];             // (4) complexity (final tiebreak)
}

// BIDIRECTIONAL move selection — pick the next (node, direction) to expand. The one-directional walk tagged each
// node with a single direction (a dependency only ever descended), so a SHARED backend node never climbed back
// UP to its other consumers and the sibling entry points (e.g. a second UI behind a second route) were starved.
// Here every reached node may go EITHER way; the explosion that monotonicity prevented is now bounded by two
// terms the developer's instinct named — CLOSENESS (hop distance from the anchor) and INTENT — so the fan
// radiates locally and the node budget caps it. Order: connectivity (crossings) first (never prune the spine),
// then delegation-over-typeref, then NEAREST, then intent, then a node's ORIGINAL direction before its REVERSE
// hop (take the reverse — the climb-up — only once the near forward frontier is spent), then complexity.
// A core node at or beyond this hop-distance from the anchor is treated as a SHARED backend hub (its up-climb
// reaches sibling entry points), not the central seam (whose up-climb is redundant). Env-tunable.
const _UPCLIMB_MIN_DIST = (() => { const v = parseInt(process.env.SEAM_UPCLIMB_MIN_DIST ?? "", 10); return Number.isFinite(v) && v > 0 ? v : 2; })();
// Intent BANDS — coarse buckets of the (0..1) intent score so a MEANINGFULLY-more-relevant node jumps the
// frontier, while CLOSENESS still orders nodes of SIMILAR relevance. Raw intent-before-closeness would let a
// hair-more-relevant FAR node thrash the budget (and undo the bound); banding only promotes a clearly-relevant
// one. Env-tunable; the default (8) buckets typical MiniLM cosine spreads (~0.1 generic .. ~0.5 on-intent).
const _INTENT_BANDS = (() => { const v = parseInt(process.env.SEAM_INTENT_BANDS ?? "", 10); return Number.isFinite(v) && v > 0 ? v : 8; })();
export type Move = { node: any; dir: "up" | "down" };
export function _nextMove(moves: Move[], crossings: Set<string>, iscore: (n: any) => number, typeRefOnly: Set<string>, dist: (id: string) => number): Move | undefined {
  const fwd = (m: Move) => ((m.node.direction === "backward" ? "down" : "up") === m.dir ? 1 : 0);   // the node's tagged direction
  const band = (n: any) => Math.round(iscore(n) * _INTENT_BANDS);                          // coarse intent bucket
  return [...moves].sort((a, b) =>
    (Number(crossings.has(b.node.id)) - Number(crossings.has(a.node.id)))                 // (1) CONNECTIVITY — never prune the spine
    || (Number(!typeRefOnly.has(b.node.id)) - Number(!typeRefOnly.has(a.node.id)))        // (2) DELEGATION over type-ref
    || (band(b.node) - band(a.node))                                                      // (3) INTENT band — a clearly-relevant node first (incl. a FAR one)
    || (dist(a.node.id) - dist(b.node.id))                                                // (4) CLOSENESS — nearest among similar-relevance (the bound)
    || (iscore(b.node) - iscore(a.node))                                                  // (5) fine intent
    || (fwd(b) - fwd(a))                                                                  // (6) original direction before the reverse hop
    || ((b.node.complexity ?? 0) - (a.node.complexity ?? 0)))[0];                         // (7) complexity
}

// FOOTPRINT EXCLUSION (a P4 prune, applied EARLY so an excluded subtree is never re-anchored — no wasted
// budget): drop test files (default; opt back with includeTests) and any node under an --exclude folder
// (matched as a path PREFIX or a whole path SEGMENT, so `--exclude generated` drops `a/generated/x`).
function _makeExclusion(opts: { excludeDirs?: string[]; includeTests?: boolean }): { excludedFile: (f?: string) => boolean; prune: (g: any) => any } {
  const exDirs = (opts.excludeDirs ?? []).map((d) => normpath(d.replace(/\\/g, "/")));
  const excludedFile = (file?: string): boolean => {
    if (!file) return false;
    const f = file.replace(/\\/g, "/");
    if (!opts.includeTests && isTestFile(f)) return true;
    return exDirs.some((d) => f === d || f.startsWith(d + "/") || f.split("/").includes(d));
  };
  const prune = (g: any): any => {
    if (!g?.nodes?.length) return g;
    const drop = new Set<string>(g.nodes.filter((n: any) => n.id !== "n1" && excludedFile(n.file)).map((n: any) => n.id));
    if (!drop.size) return g;
    return { ...g, nodes: g.nodes.filter((n: any) => !drop.has(n.id)), edges: (g.edges ?? []).filter((e: any) => !drop.has(e.from) && !drop.has(e.to)) };
  };
  return { excludedFile, prune };
}

// ── P1 + SEED (docs/grow-architecture.md) ────────────────────────────────────────────────────────────────
// The structural root: the anchor's full SURROUNDINGS — UP (consumers — who triggers it: controllers, screens)
// AND DOWN (dependencies — how it works / its outbound calls, the loading path closest to the anchor). An
// intent is a multi-call graph, not a one-way climb, so we explore both from the single anchor.
//
// DOWN used to be gated to entry points (0 consumers): descending a method's deps pulled in the DATA-MODEL TYPE
// TREE (Java same-package makes every referenced type a "dependency" → `BookingData → MemberBooking → User`).
// That fan is now defused — payload type-refs are demoted in the frontier (B), the class→method explosion is
// bounded (A), and the off-intent tail is cropped in tiering (D) — so a bidirectional neighborhood is the right
// default. (The deepest reach — UI ⇄ backend across an HTTP route — is still the COUPLING overlay's job, P3.)
async function _phaseSeed(repo: string, anchorFile: string, symbol: string, _opts: any, coStruct: any, prune: (g: any) => any): Promise<any> {
  const up: any = prune(await build_footprint(repo, anchorFile, symbol, { direction: "up", ...coStruct }));
  const down: any = prune(await build_footprint(repo, anchorFile, symbol, { direction: "down", ...coStruct }));
  for (const n of down.nodes) if (n.id !== down.anchor?.id && !n.direction) n.direction = "backward";   // deps expand DOWNSTREAM
  return merge_resolved(up, down, down.anchor?.id);
}

// ── P3 COUPLING BRIDGES (docs/grow-architecture.md) ──────────────────────────────────────────────────────
// One overlay, computed ONCE over the (anchor of the) settled structural seed and merged BEFORE the walk so a
// bridge can be CHAINED — grown STRUCTURALLY to its downstream (route handler → its @Inject'd bean; queue
// subscriber → its delegate) — WITHOUT re-coupling. This is the only place coupling touches the grow.
// COMPONENT FALLBACK: a symbol that surfaces no coupling but whose MODULE does → re-anchor as the module.
async function _phaseCoupling(repo: string, anchorFile: string, data: any, opts: any, co: any, coStruct: any, prune: (g: any) => any, coupled: Set<string>): Promise<any> {
  if (co.dataCoupling === false) return data;
  let overlay = await _anchorCouplingDelta(repo, anchorFile, data, opts, co.ctx);
  if (!overlay.nodes.length) {
    const mod: any = prune(await build_footprint(repo, anchorFile, null, { ...coStruct }));
    const modOverlay = await _anchorCouplingDelta(repo, anchorFile, mod, opts, co.ctx);
    if (modOverlay.nodes.length) { data = mod; overlay = modOverlay; }
  }
  _mergeCouplingOverlay(data, overlay);
  coupled.add(normpath(anchorFile));
  await _fanCouple(repo, data, opts, co.ctx, coupled);
  return data;
}

// FAN — couple each distinct REACHED file not yet coupled (whole-file), so a boundary on a reached node (not the
// anchor) still crosses to its consumers. Run after the SEED (the resources a hub anchor reaches) AND again
// after EXPAND (the resources the bidirectional walk climbs to) — the `coupled` set carries across so each file
// is coupled ONCE. Without the post-expand pass a sibling resource reached during the walk never bridges to its
// UI. Bounded: the resolveCoupling gate skips a no-boundary file cheaply; the grounding index is built once.
async function _fanCouple(repo: string, data: any, opts: any, ctx: EngineCtx, coupled: Set<string>): Promise<void> {
  let counter = (data.nodes ?? []).length;
  let overlay: { nodes: any[]; edges: any[]; blindspots: any[] } = { nodes: [], edges: [], blindspots: [] };
  for (const n of (data.nodes ?? [])) {
    if (n.coupling) continue;   // a coupling-overlay complement (e.g. a hub-fan member) — re-coupling it re-fans the hub; only couple STRUCTURAL files
    const f = n.file ? normpath(n.file) : "";
    if (!f || coupled.has(f)) continue;
    coupled.add(f);
    const d = await _fileCouplingDelta(repo, n.file, n.id, counter, opts, ctx);
    if (!d.nodes.length) continue;
    counter = d.counter;
    overlay = { nodes: [...overlay.nodes, ...d.nodes], edges: [...overlay.edges, ...d.edges], blindspots: [...overlay.blindspots, ...d.blindspots] };
  }
  _mergeCouplingOverlay(data, overlay);
}

// ── P2 STRUCTURAL EXPANSION (docs/grow-architecture.md) ──────────────────────────────────────────────────
// Reach the flow's terminals via consumer/dependency edges, bounded by budget. The frontier is INTENT-GUIDED
// (`_nextFrontier` orders by relevance, then crossing, then complexity) and the excluded set is dropped here.
// NOTE: per the contract this should be intent-GUIDED, not intent-PRUNED; today the ranking + exclusion still
// live in the loop (the discover-vs-prune split is the Step-2 change). Structural builds only — never couples.
async function _phaseExpand(repo: string, data: any, opts: any, coStruct: any, prune: (g: any) => any, excludedFile: (f?: string) => boolean, maxSteps: number, maxNodes: number): Promise<[any, any[]]> {
  const history: any[] = [];
  const expanded = new Set<string>(data.nodes.filter((n: any) => n.id === "n1").map((n: any) => _key(n)));
  // INTENT-WEIGHTED FRONTIER: rank the next node to grow by its passage's intent-relevance (cached def
  // embeddings); empty without an intent or embeddings → the complexity fallback. Computed ONCE per grow.
  const intentScore = new Map<string, number>();
  if (opts.intent) {
    try { for (const { def, score } of await embedScoreDefs(repo, opts.intent)) { const k = `${def.name} ${normpath(def.file)}`; if (!intentScore.has(k)) intentScore.set(k, score); } }
    catch { /* embeddings absent → complexity fallback */ }
  }
  const _iscore = (n: any): number => intentScore.get(`${n.symbol} ${normpath(n.file)}`) ?? 0;
  for (let step = 0; step < maxSteps && data.nodes.length < maxNodes; step++) {
    const g = from_resolved_graph(data);
    assign_roles(g);
    const roleById = new Map([...g.nodes.values()].map((n: any) => [n.id, n.role]));
    const crossings = new Set<string>();
    for (const e of g.resolved_edges()) if (_is_crossing(e)) crossings.add(e.dst);
    // PAYLOAD TYPE-REFS — a node reached ONLY by `type-ref` edges is a data-model DTO the anchor never calls a
    // method on (not the delegation spine). Demote it in the frontier so the budget follows calls/crossings
    // first; it's still expanded if budget remains. A node with ANY non-type-ref edge (a call/import/crossing)
    // is NOT demoted.
    const edgeKinds = new Map<string, string[]>();
    for (const e of data.edges) { (edgeKinds.get(e.from) ?? edgeKinds.set(e.from, []).get(e.from))!.push(e.kind); (edgeKinds.get(e.to) ?? edgeKinds.set(e.to, []).get(e.to))!.push(e.kind); }
    const typeRefOnly = new Set<string>();
    for (const [id, kinds] of edgeKinds) if (kinds.length && kinds.every((k) => k === "type-ref")) typeRefOnly.add(id);
    // frontier = a real symbol (not a boundary node) we haven't re-anchored yet, not excluded. CORE nodes are
    // excluded on the FORWARD/consumer side (the central seam is already covered — re-growing it adds noise), but
    // a DOWNSTREAM (backward) core node IS expanded: the mechanism chain (handler → service → repo → DB) is a
    // run of core nodes, and stopping at the first one is what left the spine thin and never reached the DB.
    // CLOSENESS — hop distance from the anchor (undirected BFS over the current footprint). The bound on
    // bidirectional expansion: nearer moves win, so the fan radiates from the anchor and the node budget caps a
    // LOCAL neighbourhood rather than a deep one-directional dive (which starved the sibling UIs).
    const anchorId = data.anchor?.id ?? "n1";
    const adj = new Map<string, string[]>();
    for (const e of data.edges as any[]) { (adj.get(e.from) ?? adj.set(e.from, []).get(e.from))!.push(e.to); (adj.get(e.to) ?? adj.set(e.to, []).get(e.to))!.push(e.from); }
    const dist = new Map<string, number>([[anchorId, 0]]);
    for (const queue = [anchorId]; queue.length; ) { const u = queue.shift()!; const du = dist.get(u)!; for (const v of (adj.get(u) ?? [])) if (!dist.has(v)) { dist.set(v, du + 1); queue.push(v); } }
    const distOf = (id: string) => dist.get(id) ?? 999;
    // BIDIRECTIONAL MOVES — each reached node offers BOTH directions (a dependency may climb back UP to its other
    // consumers — the sibling entry points — not only descend). UP of a CORE node is still skipped (the central
    // seam is covered); DOWN of a core node is kept (the mechanism chain handler→service→repo→DB).
    const moves: Move[] = [];
    for (const n of data.nodes as any[]) {
      if (n.id === "n1" || n.id === anchorId || !n.file || !n.symbol || isFlowSubject(n.kind) || excludedFile(n.file)) continue;
      const isCore = roleById.get(n.id) === "core";
      for (const d of ["up", "down"] as const) {
        if (expanded.has(`${_key(n)}::${d}`)) continue;
        // Skip the UP-climb of a NEAR core node (the central seam — already covered, re-growing it is noise), but
        // ALLOW it for a FAR core node: a shared backend service reached deep in the walk, whose other consumers
        // are the SIBLING entry points (the second UI behind a second route). Distance is the discriminator.
        if (d === "up" && isCore && distOf(n.id) < _UPCLIMB_MIN_DIST) continue;
        moves.push({ node: n, dir: d });
      }
    }
    const move = _nextMove(moves, crossings, _iscore, typeRefOnly, distOf);
    if (!move) break;
    const next = move.node;
    const down = move.dir === "down";
    expanded.add(`${_key(next)}::${move.dir}`);
    emit(`Growing the footprint to its terminals (step ${step + 1}): ${down ? "↓ down (deps)" : "↑ up (consumers)"} via ${next.symbol}…`);
    const arrow = down ? "↓down" : "↑up";
    // DE-NOISE a DOWN expansion into a class/interface reached as a DEPENDENCY: pass the files that REACHED it
    // so its down footprint surfaces ONLY the methods those callers actually invoke — not every method (the
    // full decomposition is the SEED anchor's privilege). A pure return-type ref (no calls) thus adds nothing.
    // A class reached as a DEPENDENCY shows only its CALLED methods (de-noise, A). EXCEPTION — a CONTAINER-
    // INVOKED class, whose methods have no in-repo CALLER, so restricting to caller-invoked methods empties it:
    //   • a cross-stack ROUTE/QUEUE HANDLER (an incident handler edge) — container-invoked, and
    //   • an INTERFACE IMPL reached via the interface→impl edge — the "caller" is the INTERFACE, which DECLARES
    //     the methods but never INVOKES them, so caller-files de-noise hides EVERY method (the EJB/DI data-hub
    //     bean lands as a bare class node, its CRUD + the DB calls inside them unreachable).
    // For both, surface ALL methods so the grow lands on each operation and chains DOWN to the DB (and the
    // bidirectional climb can reach the other operations' callers).
    let callerFiles: string[] | undefined;
    if (down && (next.kind === "class" || next.kind === "interface")) {
      const containerInvoked = (data.edges as any[]).some((e) => (e.from === next.id || e.to === next.id) && (isHandlerEdge(e.kind) || e.kind === "interface-impl"));
      if (!containerInvoked) {
        const fileById = new Map<string, string>(data.nodes.map((n: any) => [n.id, n.file]));
        const cf = new Set<string>();
        for (const e of data.edges as any[]) {
          if (e.from !== next.id && e.to !== next.id) continue;
          const f = fileById.get(e.from === next.id ? e.to : e.from);
          if (f && f !== next.file) cf.add(f);
        }
        callerFiles = [...cf];
      }
    }
    let add: any;
    try {
      add = prune(await build_footprint(repo, next.file, next.symbol, { direction: down ? "down" : "up", anchorLine: (next.range ?? [0])[0], callerFiles, ...coStruct }));
    } catch { dbg(`[grow]   step ${step + 1}: ${arrow} ${next.symbol} — skip (build failed)`); history.push({ node: next.symbol, added: 0, skipped: "build failed" }); continue; }
    // a move that floods the footprint with non-coupling structure (a widely-used util) doesn't advance the
    // answer — data-coupling fan is exempt (self-bounded + the intent).
    const have = new Set(data.nodes.map((x: any) => _key(x)));
    const flood = add.nodes.filter((n: any) => !have.has(_key(n)) && !n.coupling).length;
    if (flood > _MOVE_CAP) { dbg(`[grow]   step ${step + 1}: ${arrow} ${next.symbol} — skip (too broad, +${flood} > ${_MOVE_CAP})`); history.push({ node: next.symbol, added: 0, skipped: `too broad (+${flood})` }); continue; }
    // carry the move direction outward as the new nodes' DEFAULT (original) direction — the fwd-first tiebreak
    // continues the same way (consumers up, deps down), but each new node may still later reverse.
    const tag = down ? "backward" : "forward";
    for (const n of add.nodes) if (n.id !== add.anchor?.id && !n.direction) n.direction = tag;
    const before = data.nodes.length;
    data = merge_resolved(data, add, add.anchor?.id);
    dbg(`[grow]   step ${step + 1}: ${arrow} ${next.symbol} → +${data.nodes.length - before} node(s)`);
    history.push({ node: next.symbol, added: data.nodes.length - before, ...(down ? { dir: "down" } : {}) });
  }
  return [data, history];
}

// ORCHESTRATOR — the phases in order (docs/grow-architecture.md). Each is a Footprint→Footprint with a single
// concern, so a bad footprint is localisable to one phase. P4 (relevance/prune) is still partly inside P2's
// frontier today (the Step-2 split); P5 (decompose) is the caller. Behaviour is pinned by grow_contract.test.
export async function grow_to_terminals(repo: string, anchorFile: string, symbol: string,
    opts: { maxSteps?: number; maxNodes?: number; bidirectional?: boolean; dataCoupling?: boolean; dataCouplingLlm?: boolean; model?: string; claudeBin?: string | null; flagTruncation?: boolean; intent?: string; excludeDirs?: string[]; includeTests?: boolean; ctx?: EngineCtx } = {}): Promise<[any, any[]]> {
  const maxSteps = opts.maxSteps ?? 12, maxNodes = opts.maxNodes ?? 80;
  const { excludedFile, prune } = _makeExclusion(opts);
  // ctx shared across all grow moves (repo indices built once). A caller may pass its OWN ctx to share the
  // expensive repo-wide indices across SEVERAL grows (e.g. the anchor probes build the coupling index ONCE).
  const co = { dataCoupling: opts.dataCoupling, dataCouplingLlm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin, ctx: opts.ctx ?? new EngineCtx() };
  if (opts.intent && !co.ctx.rankKeys) co.ctx.rankKeys = makeIntentKeyRanker(opts.intent);   // intent prior for the coupling hub-fan cap
  const coStruct = { ...co, dataCoupling: false };   // STRUCTURAL builds — coupling is the P3 overlay only
  const coupled = new Set<string>();   // files already coupled — carried across the seed + post-expand fans (couple each once)
  let data = await _phaseSeed(repo, anchorFile, symbol, opts, coStruct, prune);              // P1 + seed
  const seedN = data.nodes.length, seedDeps = data.nodes.filter((n: any) => n.direction === "backward").length;
  dbg(`[grow] P1 seed ${symbol}: ${seedN - 1} structural node(s)${seedDeps ? ` (incl. ${seedDeps} dep(s) — entry point)` : " (consumers only)"}`);
  data = await _phaseCoupling(repo, anchorFile, data, opts, co, coStruct, prune, coupled);   // P3 coupling bridges (seed)
  dbg(`[grow] P3 coupling: +${data.nodes.length - seedN} bridge node(s)`);
  const [grown, history] = await _phaseExpand(repo, data, opts, coStruct, prune, excludedFile, maxSteps, maxNodes);   // P2 expand
  data = grown;
  dbg(`[grow] P2 expand: ${history.length} step(s) → ${data.nodes.length} node(s) total (budget ${maxSteps} steps / ${maxNodes} nodes)`);
  // P3 (deep) — couple the boundary files the bidirectional walk CLIMBED to (sibling resources reached during
  // expand, not in the seed), so their routes cross to their UIs. `coupled` skips the seed files already done.
  if (co.dataCoupling !== false) { const n0 = data.nodes.length; await _fanCouple(repo, data, opts, co.ctx, coupled); dbg(`[grow] P3 deep-couple: +${data.nodes.length - n0} bridge node(s)`); }
  // TRUNCATION HONESTY (real grow only): flag a node the resolver could not expand (unsupported file / parse
  // failure) — the path beyond it is silently unmapped. struct_score ignores blindspots so selection is unaffected.
  if (opts.flagTruncation) {
    data.blindspots = data.blindspots ?? [];
    for (const h of history) if (h.skipped === "build failed")
      data.blindspots.push({ node: h.node, mechanism: "unfollowable",
        evidence: "the resolver could not expand this node (unsupported file / parse failure) — the path beyond it is not mapped", candidates: [] });
  }
  return [data, history];
}
