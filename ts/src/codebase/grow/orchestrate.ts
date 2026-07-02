// Port of src/codebase/orchestrate.py — P5 LLM-directional auto-orchestration: GROW a footprint
// toward answering a question. Seed from a confirmed anchor, then LOOP: show the LLM the current
// footprint + the question, let it pick ONE node and a DIRECTION (up = consumers / down = deps) that
// advances toward the answer, expand+merge, repeat — until done or a step budget. The LLM only
// CHOOSES moves over the deterministic primitives; it never invents an edge.
import { run_pass, run_pass_async, registerPass, available as llmAvailable, fastCheapBackend, ClassifierError as LLMError } from "../../core/llm.js";
import { emit, dbg } from "../../core/progress.js";

const PASS = registerPass({ tag: "orchestrate", tier: "cheap", note: "auto-grow move picker (node + direction per step)" });
import { from_resolved_graph } from "../../core/graph_ir.js";
import { assign_roles, _is_crossing } from "../codebase.js";
import { _key, merge_resolved } from "../scan/expand.js";
import { build_footprint } from "../scan/index.js";
import { makeIntentKeyRanker } from "./key_ranker.js";
import { ubiquityIndex, ubiquityOf } from "./ubiquity.js";
import { RegionCentroid } from "./field.js";
import { embedScoreDefs } from "../scan/def_embed.js";
import { normpath } from "../../core/resolve/walk.js";
import { isTestFile, } from "../../core/resolve/consumers.js";
import { isFlowSubject, isHandlerEdge, isProduceEdge, resolveCoupling } from "../coupling/index.js";
import { _read } from "../scan/ast_units.js";
import { defs_in_file } from "../scan/def_table.js";
import { defs_in_file_treesitter } from "../scan/def_treesitter.js";
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

// Merge the coupling overlay onto the settled footprint. DEDUP BY CONTENT (`_key` = file#line#kind), like
// merge_resolved: `_chain_route_consumers` re-derives the SAME route→consumer crossing every time any file
// sharing that route base is coupled (seed, fan, deep-fan), each pass minting a fresh `dc` id — so the same
// synthetic node was appended N× and `_extract_suggested_seams` minted N duplicate seams from it (the region
// showed loadBookings/install/every route literal 12-18×). A content-equal node already present REUSES its id
// (edges remap onto it); only genuinely new complements are pushed. Kind stays in the key so a synthetic
// boundary node never collapses onto the real method at the same line. Re-id still guards raw id collisions.
export function _mergeCouplingOverlay(data: any, overlay: { nodes: any[]; edges: any[]; blindspots: any[] }): void {
  if (!overlay?.nodes?.length) return;
  const used = new Set<string>((data.nodes ?? []).map((n: any) => n.id));
  const byKey = new Map<string, string>((data.nodes ?? []).map((n: any) => [_key(n), n.id]));
  const remap = new Map<string, string>();
  let k = (data.nodes ?? []).length;
  for (const n of overlay.nodes) {
    const ck = _key(n);
    const dupe = byKey.get(ck);
    if (dupe !== undefined) { if (dupe !== n.id) remap.set(n.id, dupe); continue; }   // content-equal → reuse it
    let id = n.id;
    while (used.has(id)) id = `dc${k++}`;
    if (id !== n.id) remap.set(n.id, id);
    used.add(id); byKey.set(ck, id); data.nodes.push({ ...n, id });
  }
  const eset = new Set<string>((data.edges ?? []).map((e: any) => `${e.from} ${e.to} ${e.kind ?? ""}`));
  for (const e of overlay.edges) {
    const from = remap.get(e.from) ?? e.from, to = remap.get(e.to) ?? e.to;
    const ek = `${from} ${to} ${e.kind ?? ""}`;
    if (eset.has(ek)) continue;                          // the re-derived crossing brings the same edge back
    eset.add(ek); data.edges.push({ ...e, from, to });
  }
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
// ORDER the whole frontier best-first by the same criteria the single-pick walk used. Single-pick takes [0];
// the WAVEFRONT (flood) mode processes the WHOLE ordered list per wave — same priority, so under a node budget
// the flood still fills the most-relevant region first (the "spine" is just the degenerate linear flood).
export function _orderMoves(moves: Move[], crossings: Set<string>, iscore: (n: any) => number, typeRefOnly: Set<string>, dist: (id: string) => number, isHub: (n: any) => boolean = () => false): Move[] {
  const fwd = (m: Move) => ((m.node.direction === "backward" ? "down" : "up") === m.dir ? 1 : 0);   // the node's tagged direction
  const band = (n: any) => Math.round(iscore(n) * _INTENT_BANDS);                          // coarse intent bucket
  return [...moves].sort((a, b) =>
    (Number(crossings.has(b.node.id)) - Number(crossings.has(a.node.id)))                 // (1) CONNECTIVITY — never prune the spine
    || (Number(!typeRefOnly.has(b.node.id)) - Number(!typeRefOnly.has(a.node.id)))        // (2) DELEGATION over type-ref
    || (Number(isHub(a.node)) - Number(isHub(b.node)))                                    // (2.5) UBIQUITY — a non-crossing shared hub grows LAST (default no-op)
    || (band(b.node) - band(a.node))                                                      // (3) INTENT band — a clearly-relevant node first (incl. a FAR one)
    || (dist(a.node.id) - dist(b.node.id))                                                // (4) CLOSENESS — nearest among similar-relevance (the bound)
    || (iscore(b.node) - iscore(a.node))                                                  // (5) fine intent
    || (fwd(b) - fwd(a))                                                                  // (6) original direction before the reverse hop
    || ((b.node.complexity ?? 0) - (a.node.complexity ?? 0)));                            // (7) complexity
}
export function _nextMove(moves: Move[], crossings: Set<string>, iscore: (n: any) => number, typeRefOnly: Set<string>, dist: (id: string) => number): Move | undefined {
  return _orderMoves(moves, crossings, iscore, typeRefOnly, dist)[0];
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
  // A coupling-overlay node is coupled ONLY if it PRODUCES a boundary — a route/queue/event HANDLER or a data
  // WRITER (incident produce/handler edge). Such a node is a RESOURCE: reached via ONE of its routes, its file
  // may serve OTHERS whose consumers we still want (a REST resource reached via its summary route, whose create/
  // update routes lead to the UI). A pure CONSUMER coupling node (a hub-fan member reading a shared table) is
  // skipped — re-coupling it only re-fans the hub (keeps hub_damping intact). This is the fix for "the grow
  // reaches the data bean + its REST resource via one route but never its OTHER routes' UI consumers".
  const producer = new Set<string>();
  for (const e of (data.edges ?? [])) if (isHandlerEdge(e.kind) || isProduceEdge(e.kind)) { producer.add(e.from); producer.add(e.to); }
  // GROUNDED REACH — a node reached ONLY via a receiver-agnostic bare-name `call` match (RESOLVED_PARTIAL: the
  // resolver's "honest ambiguity" from a method-name coincidence — core/resolution.ts says a PARTIAL link must
  // NOT be followed) is not a confirmed part of the flow. Fanning coupling from it manufactures a boundary
  // crossing out of a name collision: a test base class's generic `data()`/`response()` "matches" every bean,
  // and each bean's routes/tables then fan to counterparts across the repo (the "coupling scans everything"
  // explosion off an anchor that itself touches no boundary). Couple a node only when it has a GROUNDED reach —
  // RESOLVED_FULL, or a structural PARTIAL that isn't a bare-name call (a sole interface-impl / dispatch edge,
  // which IS a provable runtime binding). The anchor (n1) is always grounded. Producer/resource coupling nodes
  // are exempt (a boundary edge already grounds them). This is the seed-side twin of the cross-language callsite
  // gate: seed coupling on GROUNDED facts, never a name guess.
  const grounded = new Set<string>(["n1"]);
  for (const e of (data.edges ?? [])) {
    if (e.provenance === "RESOLVED_FULL" || (e.provenance === "RESOLVED_PARTIAL" && e.kind !== "call")) { grounded.add(e.from); grounded.add(e.to); }
  }
  for (const n of (data.nodes ?? [])) {
    if (n.coupling && !producer.has(n.id)) continue;   // skip pure-consumer coupling nodes; couple producer/resource ones
    if (!producer.has(n.id) && !grounded.has(n.id)) continue;   // don't fan a boundary from a bare-name call match
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

// The `[grow]` log prefix, tagged `·probe` when this grow is the throwaway footprint-scoping pre-grow
// (`grow_footprint_scoped` sets ctx.stableFloor). The probe runs a FULL grow — seed → coupling → wave
// expansion — to discover the flow's files, then discards the footprint; its wave lines are otherwise
// indistinguishable from the real grow's, so it reads as "the grow is still growing" (see [coupling·probe]).
const _gtag = (ctx?: EngineCtx): string => (ctx?.stableFloor ? "grow·probe" : "grow");

// ── P2 STRUCTURAL EXPANSION (docs/grow-architecture.md) ──────────────────────────────────────────────────
// Reach the flow's terminals via consumer/dependency edges, bounded by budget. The frontier is INTENT-GUIDED
// (`_nextFrontier` orders by relevance, then crossing, then complexity) and the excluded set is dropped here.
// NOTE: per the contract this should be intent-GUIDED, not intent-PRUNED; today the ranking + exclusion still
// live in the loop (the discover-vs-prune split is the Step-2 change). Structural builds only — never couples.

// Apply ONE (node, direction) expansion to the footprint: build that node's directional footprint, reject a
// flood (a widely-used util), and merge. Shared by the single-pick walk and the wavefront flood so the two
// modes differ ONLY in how the frontier is SCHEDULED (one best move per step vs the whole ordered frontier per
// wave), not in how a move is executed. Returns the (possibly unchanged) footprint and how many nodes it added.
async function _applyMove(repo: string, data: any, move: Move, label: string, coStruct: any, prune: (g: any) => any, history: any[]): Promise<{ data: any; added: number }> {
  const next = move.node;
  const down = move.dir === "down";
  // QUALIFY with the enclosing class so same-named methods in different classes are distinguishable in the
  // progress trace (BookingsBean.createBooking vs AcmeCheckBookingsService.createBooking) — grounded on the
  // node's own `enclosing`, not a file-name guess; omitted when absent or redundant (a class node).
  const qual = next.enclosing && next.enclosing !== next.symbol ? `${next.enclosing}.${next.symbol}` : next.symbol;
  emit(`Growing the footprint to its terminals (${label}): ${down ? "↓ down (deps)" : "↑ up (consumers)"} via ${qual}…`);
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
  } catch { dbg(`[${_gtag(coStruct?.ctx)}]   ${label}: ${arrow} ${qual} — skip (build failed)`); history.push({ node: next.symbol, added: 0, skipped: "build failed" }); return { data, added: 0 }; }
  // a move that floods the footprint with non-coupling structure (a widely-used util) doesn't advance the
  // answer — data-coupling fan is exempt (self-bounded + the intent).
  const have = new Set(data.nodes.map((x: any) => _key(x)));
  const flood = add.nodes.filter((n: any) => !have.has(_key(n)) && !n.coupling).length;
  if (flood > _MOVE_CAP) { dbg(`[${_gtag(coStruct?.ctx)}]   ${label}: ${arrow} ${qual} — skip (too broad, +${flood} > ${_MOVE_CAP})`); history.push({ node: next.symbol, added: 0, skipped: `too broad (+${flood})` }); return { data, added: 0 }; }
  // carry the move direction outward as the new nodes' DEFAULT (original) direction — the fwd-first tiebreak
  // continues the same way (consumers up, deps down), but each new node may still later reverse.
  const tag = down ? "backward" : "forward";
  for (const n of add.nodes) if (n.id !== add.anchor?.id && !n.direction) n.direction = tag;
  const before = data.nodes.length;
  const merged = merge_resolved(data, add, add.anchor?.id);
  const added = merged.nodes.length - before;
  dbg(`[${_gtag(coStruct?.ctx)}]   ${label}: ${arrow} ${qual} → +${added} node(s)`);
  history.push({ node: next.symbol, added, ...(down ? { dir: "down" } : {}) });
  return { data: merged, added };
}

// WAVEFRONT (flood-fill) mode — opt-in via SEAM_GROW_WAVE. Instead of re-ranking the whole frontier and taking
// ONE best move per step (re-deriving the role/distance maps every step — O(steps·N) — and re-crossing paths a
// stabler dedup would have caught), each WAVE recomputes the frontier ONCE and expands EVERY ready head; the
// nodes a wave adds become the NEXT wave's frontier (classic BFS region-growing). Heads are still processed in
// relevance order, so a node budget fills the most-relevant region first. The dedup key is file#symbol#dir (the
// expansion's true identity) — NOT _key's file#line#kind — so a coupling-re-added node isn't re-expanded.
// DEFAULT-ON when a fast local SLM (Ollama) is configured: wave+LLM-border is the more reliable picker (the
// deterministic flood overgrows into adjacent concerns — validated: det 48 files vs wave+border 29-32, the
// border cropping billing/oauth/pagination noise), and a fast cheap backend makes it ALSO fast (~45s). Without
// a fast backend (claude-only / offline / MCP host-bus) it stays OFF → the instant deterministic picker, so
// offline behaviour + the grow oracles are unchanged. SEAM_GROW_WAVE=0/1 forces it either way.
const _envFlag = (v: string | undefined): boolean | undefined => (v === undefined || v === "") ? undefined : (v === "1" || v === "true");
const _GROW_WAVE = () => _envFlag(process.env.SEAM_GROW_WAVE) ?? fastCheapBackend();

// LLM-PRUNE BORDER (wave mode, opt-in via SEAM_GROW_BORDER_LLM) — the validated discriminator. Embedding cosine
// can't reason that "merge date-ranges" is part of "check availability" (it scored that 0.11 and a booking-
// lifecycle event 0.47 — wrong-signed); the irreducibly-semantic "is this node ON the intent?" judgement is the
// LLM's. We keep it OUT of the per-node loop: ONCE PER WAVE, one cheap (haiku, thinking-off) call classifies the
// wave's NEW candidate ring over a COMPACT skeleton (name + container + file + kind — no bodies), and only the
// in-scope nodes are flooded through. Frontier-evaluable (a node is judged BEFORE its footprint is built, so the
// cut subtree is never built), bounded (≈ one call per wave), cached per node (decided once, never re-asked).
const _GROW_BORDER_LLM = () => _envFlag(process.env.SEAM_GROW_BORDER_LLM) ?? fastCheapBackend();
const PRUNE_PASS = registerPass({ tag: "grow-border", tier: "cheap", note: "wave-level intent border — keep only the candidates ON the intent" });
const _PRUNE_BATCH = 50;   // candidates per call — small enough for a reliable per-candidate JSON reply

const _MEMBER_HINT_CAP = 8;
function _candLabel(n: any, members?: string[]): string {
  const encl = n.enclosing && n.enclosing !== n.symbol ? ` (${n.enclosing})` : "";
  // For a CLASS/interface, list its methods — WHAT it does. A bare `BookingsBean — … — class` tells a weak SLM
  // nothing, so it drops the data-layer bean the flow delegates to; `BookingsBean {createBooking, updateBooking,
  // getUpcomingBookings}` makes it obvious the class realises a "manage bookings" intent. Grounded (real member
  // nodes), capped, so it names the behaviour without a body dump.
  const mem = members && members.length ? ` {${members.slice(0, _MEMBER_HINT_CAP).join(", ")}${members.length > _MEMBER_HINT_CAP ? ", …" : ""}}` : "";
  return `${n.symbol}${encl}${mem} — ${n.file ? normpath(n.file) : "?"} — ${n.kind ?? "symbol"}`;
}

// REGION REACH — the resolved relation(s) that REACHED a candidate from a node ALREADY IN the region (the flood
// parent). The border used to judge each node in ISOLATION ("is this on the intent?"), which reads a data-layer
// bean as "generic → exclude" and cuts the mechanism the flow delegates to. Feeding the SLM WHO reached the
// candidate and HOW turns the question into the REGION-SHAPED one — "does this CONTINUE the flooded concern or
// DEPART into another?" — which the cheap model answers far better (a resource → bean → repo continuation is
// obvious once you see it's what the on-intent handler CALLS). Phrasing is from the candidate's point of view.
const _RELATION_PHRASE: Record<string, [string, string]> = {   // [reached-from side, points-to side]
  call: ["called by", "calls"], import: ["used by", "uses"], reference: ["referenced by", "references"],
  "interface-impl": ["implemented by", "implements"], contains: ["a member of", "contains"],
  "route-fetch": ["reached over a route from", "reaches over a route to"],
  "route-serve": ["reached over a route from", "reaches over a route to"],
  "data-coupling": ["shares data with", "shares data with"], "type-ref": ["a data type used by", "uses the type"],
};
export function _reachPhrases(n: any, edges: any[], isReacher: (id: string) => boolean, symOf: (id: string) => string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const rank = (k: string) => (k === "call" ? 0 : k === "route-serve" || k === "route-fetch" ? 1 : k === "import" || k === "reference" ? 2 : 3);
  const cands: { r: number; s: string }[] = [];
  for (const e of edges) {
    let dir: "from" | "to" | null = null, other = "";
    if (e.to === n.id && e.from !== n.id && isReacher(e.from)) { dir = "from"; other = e.from; }
    else if (e.from === n.id && e.to !== n.id && isReacher(e.to)) { dir = "to"; other = e.to; }
    if (!dir) continue;
    const pair = _RELATION_PHRASE[e.kind] ?? ["reached from", "reaches"];
    const s = `${dir === "from" ? pair[0] : pair[1]} ${symOf(other)}`;
    if (seen.has(s)) continue; seen.add(s);
    cands.push({ r: rank(e.kind), s });
  }
  cands.sort((a, b) => a.r - b.r);
  for (const c of cands.slice(0, 2)) out.push(c.s);
  return out.length ? out.join(", ") : "(reached from the region)";
}

export function _prunePrompt(intent: string, cands: { i: number; n: any; ctx: string; members?: string[] }[]): string {
  return [
    `A developer is mapping the code REGION for ONE intent: "${intent}" — a flood-fill outward from an anchor over`,
    "the code's real call/dependency graph. Each candidate below was REACHED from a node ALREADY IN the region, via",
    "a resolved relation (shown after the ·). Being CALLED by the flow is NOT enough — a handler triggers many",
    "SIDE-CONCERNS along the way that are not what the intent is about. For EACH, decide if it is ON the intent's",
    "own path or a DEPARTURE into another concern.",
    "KEEP the mechanism that realises THIS intent: the service / bean / repository / DB / handler the flow",
    "delegates THROUGH to read or write the data the intent is about, and the steps between them. A class whose",
    "OWN methods (listed in {…}) name the intent's operations IS the mechanism — keep it.",
    "DROP a SIDE-CONCERN even though on-intent code calls it — notifications / messaging / broadcast, exports /",
    "integrations, document / vault management, audit / logging, security / permission / auth checks, search /",
    "indexing, rendering / charts / analytics, config, or an unrelated domain. These are triggered BY the flow but",
    "are not the flow. When unsure, KEEP a node the flow CALLS or DEPENDS ON (a data/service/repository step) and",
    "DROP only a clear side-concern — losing the data layer the flow reaches is worse than one extra neighbour.",
    "Each line is `[index] name (container) {methods} — file — kind · <how it was reached>`.",
    "",
    ...cands.map((c) => `[${c.i}] ${_candLabel(c.n, c.members)} · ${c.ctx}`),
    "",
    'Output ONLY a JSON array, ONE object per candidate: [{"id":"<index>","keep":true|false}, …]',
  ].join("\n");
}

// RESIDUAL-BAND gating context (Phase 3): the deterministic signals that auto-decide the confident ends of
// the ring so ONLY the ambiguous middle reaches the SLM. `field` = intent cosine (the discriminative field —
// the centroid was a NO-GO, see grow-phase2-matrix.md); `ubiquity` = cross-module fan-in. hi/lo/fan are the
// SLM-agreement-calibrated margins.
export interface BandCtx { field: (n: any) => number; ubiquity: (n: any) => number; hi: number; lo: number; fan: number; }

// Classify every not-yet-decided node as in-scope / out, ONE batched call per ≤_PRUNE_BATCH ring, caching the
// verdict per node id so a node is judged exactly once across the whole grow. `decided` persists across waves.
// `bands` (residual mode) auto-decides the confident ends first, so the batches carry only the residual band.
export async function _llmPruneInShape(data: any, anchorId: string, opts: any, decided: Map<string, boolean>, bands?: BandCtx): Promise<Set<string>> {
  decided.set(anchorId, true);   // the anchor is always the intent's centre
  let undecided = (data.nodes as any[]).filter((n) => n.id !== anchorId && n.file && n.symbol && !isFlowSubject(n.kind) && !decided.has(n.id));
  // RESIDUAL BAND (Phase 3, opt-in): partition the ring deterministically BEFORE the SLM sees it —
  //  • auto-KEEP: bears a grounded crossing (I4 — never auto-dropped), or field ≥ hi (confidently on-intent);
  //  • auto-DROP: cross-module ubiquity ≥ fan AND field ≤ lo (confident shared side-concern; crossing-free);
  //  • residual (the middle): goes to the SLM exactly as before.
  // Margins are SLM-agreement-calibrated (≥95% on the fixture). Recorded on data for the harness (LLM-call drop).
  if (bands) {
    const bearers = new Set<string>();
    for (const e of data.edges as any[]) if (_is_crossing(e)) { bearers.add(String(e.from)); bearers.add(String(e.to)); }
    let autoKeep = 0, autoDrop = 0;
    undecided = undecided.filter((n) => {
      if (bearers.has(String(n.id)) || n.coupling || bands.field(n) >= bands.hi) { decided.set(n.id, true); autoKeep++; return false; }   // auto-KEEP (crossing first → I4)
      if (bands.ubiquity(n) >= bands.fan && bands.field(n) <= bands.lo) { decided.set(n.id, false); autoDrop++; return false; }            // auto-DROP (non-crossing only — crossings already kept)
      return true;   // residual → SLM
    });
    const s = ((data as any)._residualStats ??= { autoKeep: 0, autoDrop: 0, slm: 0 });
    s.autoKeep += autoKeep; s.autoDrop += autoDrop; s.slm += undecided.length;
  }
  // REGION-SHAPED CONTEXT — for each candidate, the resolved relation(s) that reached it from a node ALREADY IN
  // the region (a prior-kept node, the anchor, or a boundary marker the flood crossed). The border judges
  // CONTINUATION-vs-DEPARTURE with this, not each node in isolation. A reacher is anything already anchored in the
  // region: the anchor, a kept node, or a boundary node (flow-subject / coupling crossing) the flood grew through.
  const byId = new Map<string, any>((data.nodes as any[]).map((n) => [n.id, n]));
  const nodeSym = new Map<string, string>((data.nodes as any[]).map((n) => [n.id, n.enclosing && n.enclosing !== n.symbol ? `${n.enclosing}.${n.symbol}` : n.symbol]));
  const isReacher = (id: string): boolean => { if (id === anchorId || decided.get(id) === true) return true; const nd = byId.get(id); return !!nd && (isFlowSubject(nd.kind) || !!nd.coupling); };
  const ctxOf = (n: any): string => _reachPhrases(n, data.edges as any[], isReacher, (id) => nodeSym.get(id) ?? id);
  // MEMBERS — a class/interface candidate's own methods, so the judge sees WHAT the class does. A bare
  // `BookingsBean — class` gets dropped by a weak SLM; `BookingsBean {createBooking, updateBooking, …}` obviously
  // realises "manage bookings". Prefer the GROWN `contains` children; but the PER-WAVE border judges a class
  // BEFORE its methods are expanded (frontier eval), so `contains` is empty then — fall back to a cheap regex def
  // scan of the class's own file (`defs_in_file`, offline, cached per file). Grounded either way (real members).
  const membersOf = new Map<string, string[]>();
  for (const e of (data.edges ?? []) as any[]) if (e.kind === "contains") { const m = byId.get(String(e.to)); if (m?.symbol) (membersOf.get(String(e.from)) ?? membersOf.set(String(e.from), []).get(String(e.from))!).push(m.symbol); }
  // Pre-compute each class/interface candidate's members: the GROWN `contains` children if any, else a source def
  // scan (tree-sitter — handles Java `public class` the JS-oriented regex misses; regex fallback offline). Cached
  // per file. Awaited up front so the (sync) batch build below can just read the map.
  const _fileDefs = new Map<string, any[]>();
  const classMembers = new Map<string, string[]>();
  for (const n of undecided) {
    if (n.kind !== "class" && n.kind !== "interface") continue;
    const grown = membersOf.get(String(n.id));
    if (grown && grown.length) { classMembers.set(String(n.id), grown); continue; }
    if (!opts.repo || !n.file) continue;
    let defs = _fileDefs.get(n.file);
    if (defs === undefined) { const rd = _read(opts.repo, n.file); defs = rd ? ((await defs_in_file_treesitter(n.file, rd[0])) ?? defs_in_file(n.file, rd[0])) : []; _fileDefs.set(n.file, defs); }
    const mem = defs.filter((d) => d.enclosing === n.symbol && (d.kind === "method" || d.kind === "function")).map((d) => d.name);
    if (mem.length) classMembers.set(String(n.id), mem);
  }
  const memOf = (n: any): string[] | undefined => classMembers.get(String(n.id));
  // BATCHES OF ONE WAVE'S ring run CONCURRENTLY — each ≤_PRUNE_BATCH slice is an independent classify over a
  // DISJOINT candidate set (no cross-batch dependency), so on a wide wave the wall is the slowest batch, not their
  // sum (the cheap-backend / Ollama path serves concurrent requests). The verdict-write is order-independent
  // (each batch owns its own nodes); JS runs each .then to completion, so no race on `decided`.
  const batches: { i: number; n: any; ctx: string; members?: string[] }[][] = [];
  for (let off = 0; off < undecided.length; off += _PRUNE_BATCH) batches.push(undecided.slice(off, off + _PRUNE_BATCH).map((n, k) => ({ i: k, n, ctx: ctxOf(n), members: memOf(n) })));
  await Promise.all(batches.map(async (batch) => {
    emit(`Judging the intent border with the LLM (${batch.length} candidate${batch.length === 1 ? "" : "s"})…`);
    let out: Map<string, any> | null = null;
    try { out = await run_pass_async(_prunePrompt(opts.intent, batch), { model: opts.model, claudeBin: opts.claudeBin, tag: PRUNE_PASS.tag }); }
    catch (e) { dbg(`[grow] border-llm: pass failed (${(e as Error).message}) — keeping this ring (degrade to flood)`); }
    // run_pass keys the Map by each reply object's `id`; here that's the candidate index. A node MISSING from a
    // parsed reply → EXCLUDE; a whole-batch parse failure / absent backend → KEEP (degrade to flood; cap bounds it).
    const parsed = !!out && batch.some(({ i }) => out!.has(String(i)));
    for (const { i, n } of batch) {
      const v = parsed ? out!.get(String(i)) : null;
      decided.set(n.id, parsed ? (!!v && (v.keep === true || v.keep === "true")) : true);
    }
  }));
  const inScope = new Set<string>();
  for (const [id, ok] of decided) if (ok) inScope.add(id);
  return inScope;
}

async function _phaseExpand(repo: string, data: any, opts: any, coStruct: any, prune: (g: any) => any, excludedFile: (f?: string) => boolean, maxSteps: number, maxNodes: number): Promise<[any, any[]]> {
  const history: any[] = [];
  const expanded = new Set<string>(data.nodes.filter((n: any) => n.id === "n1").map((n: any) => _key(n)));
  // INTENT-WEIGHTED FRONTIER: rank the next node to grow by its passage's intent-relevance (cached def
  // embeddings); empty without an intent or embeddings → the complexity fallback. Computed ONCE per grow.
  // opts.wave / opts.borderLlm OVERRIDE the env toggles (production reads env; a caller — a test — passes them
  // directly so it never races the process-global env under bun's concurrent file scheduling).
  const wave = opts.wave ?? _GROW_WAVE();
  // INTENT FIELD — per-node relevance from cached def embeddings (empty without an intent/embeddings → the
  // complexity fallback). SINGLE-PICK uses the whole-repo embed-RECALL field (lexically pre-filtered, computed
  // ONCE) — its historical behaviour. WAVEFRONT uses a DENSE field: it embeds every REACHED file's defs against
  // the intent (the scoped `embedScoreDefs` SKIPS the pre-filter), extended incrementally as the flood grows.
  // The sparse recall field scored on-intent MECHANISM nodes (a busy-times / date-range helper) at 0 and so the
  // soft border cut them; the dense field scores them honestly, so the border cuts at REAL relevance cliffs.
  const intentScore = new Map<string, number>();
  const vecByKey = new Map<string, number[]>();   // def key → its embedding vector (for the region-centroid field)
  const scoredFiles = new Set<string>();
  const densify = async (): Promise<void> => {       // WAVE: embed the reached files not yet scored
    if (!opts.intent) return;
    const want = new Set<string>();
    for (const n of data.nodes as any[]) { const f = n.file ? normpath(n.file) : ""; if (f && !scoredFiles.has(f)) want.add(f); }
    if (!want.size) return;
    for (const f of want) scoredFiles.add(f);
    try { for (const { def, score, vec } of await embedScoreDefs(repo, opts.intent, want)) { const k = `${def.name} ${normpath(def.file)}`; intentScore.set(k, score); if (vec) vecByKey.set(k, vec); } }
    catch { /* embeddings absent → field stays empty → border OFF (flood-all), unchanged degradation */ }
  };
  if (!wave && opts.intent) {
    try { for (const { def, score } of await embedScoreDefs(repo, opts.intent)) { const k = `${def.name} ${normpath(def.file)}`; if (!intentScore.has(k)) intentScore.set(k, score); } }
    catch { /* embeddings absent → complexity fallback */ }
  }
  const _iscore = (n: any): number => intentScore.get(`${n.symbol} ${normpath(n.file)}`) ?? 0;
  // REGION-CENTROID FIELD (wave, SEAM_GROW_BORDER_FIELD / opts.borderField): `intent` (default) scores a
  // candidate by cosine to the INTENT text; `centroid` by cosine to the running KEPT-REGION centroid;
  // `blend` = max of the two. The centroid is a NEW field for the SAME soft border (I7 — no second walker),
  // seeded by the anchor and accumulated (weighted) as waves keep nodes, so a mechanism node with no intent
  // vocabulary (`mergeIntervals` under "check availability") is scored by its EMBEDDING PROXIMITY to what the
  // flow already kept — the case the intent field scores near-zero and cuts. Arithmetic over the cached def
  // vectors: no new embedding work. Empty vectors → 0 → the border floods (I3), same degradation as `intent`.
  const fieldMode = wave ? (opts.borderField ?? process.env.SEAM_GROW_BORDER_FIELD ?? "intent") : "intent";
  const useCentroid = fieldMode === "centroid" || fieldMode === "blend";
  const keyOf = (n: any): string => `${n.symbol} ${normpath(n.file)}`;
  const centroid = new RegionCentroid();
  const contributed = new Set<string>();                            // node ids already folded into the centroid
  // fold every not-yet-counted region node into the centroid; the anchor + wave-1 keeps weigh ×2 (drift control)
  const _growCentroid = (step: number): void => {
    if (!useCentroid) return;
    for (const n of data.nodes as any[]) if (n.id && !contributed.has(n.id)) { contributed.add(n.id); centroid.add(vecByKey.get(keyOf(n)), step === 0 ? 2 : 1); }
  };
  // the candidate score the SOFT BORDER consumes — the selected field (default `intent` → byte-identical).
  const _fieldScore = (n: any): number => {
    const iv = _iscore(n);
    if (!useCentroid) return iv;
    const cv = centroid.score(vecByKey.get(keyOf(n)));
    return fieldMode === "centroid" ? cv : Math.max(iv, cv);
  };
  // EXPANSION IDENTITY. Single-pick keys on `_key`#dir (file#line#kind) — its historical behaviour. The wavefront
  // keys on file#symbol#dir: the (file, symbol, direction) triple a build_footprint is keyed by, so the SAME
  // logical node re-added by the coupling overlay at a different line/kind is NOT re-expanded (kills the visible
  // re-crossing). Mode-local so the default path is byte-identical.
  const expKey = wave
    ? (n: any, d: string) => `${normpath(n.file ?? "")}#${n.symbol ?? ""}#${d}`
    : (n: any, d: string) => `${_key(n)}::${d}`;
  // SOFT INTENT-BORDER tolerance (wavefront only). Unset → border OFF (flood every reachable node). A float t≥0
  // floods through a node as long as relevance hasn't fallen more than t below the path's high-water mark.
  const borderTol = wave ? (opts.borderTol ?? (process.env.SEAM_GROW_BORDER_TOL ? parseFloat(process.env.SEAM_GROW_BORDER_TOL) : null)) : null;
  // LLM-prune border takes precedence over the embedding tol border when on AND a backend exists (else it falls
  // back to the tol border / flood). `decided` caches each node's in-scope verdict across all waves.
  // STABLE-FLOOR PROBE: the footprint-scoping pre-grow (`grow_footprint_scoped`) DISCARDS its footprint — only the
  // files it reaches are kept, to scope the real grow's LLM key-discovery. It is the "cheap DETERMINISTIC floor"
  // pre-grow, so it must run LLM-FREE (the same reason line ~869 skips `_borderCoupling` under stableFloor). Running
  // the wave border + crop here doubled the LLM calls on a footprint we throw away. Gate them off in the probe.
  const stableFloor = coStruct.ctx?.stableFloor;
  const llmPrune = !stableFloor && wave && (opts.borderLlm ?? _GROW_BORDER_LLM()) && opts.intent && llmAvailable(opts.claudeBin);
  const decided = new Map<string, boolean>();
  // HUB GATE (wave, opt-in via SEAM_HUB_GATE / opts.hubGate) — a DETERMINISTIC bound on the off-intent overgrow
  // the profiling exposed: a hub node (a shared repo/util/accessor) whose expansion adds a WIDE fan of pure
  // NON-crossing consumers. Those consumers are sibling/other-feature entry points, not this flow's spine, so
  // treating all N as spine is the 62%-off-intent bloat (and, on a big repo, the seconds-per-hub build). We
  // drop such a fan and stop it seeding further waves. INVARIANT (terminal-preservation): a fan that bears ANY
  // grounded crossing or flow-subject is SPINE-WARD and is NEVER gated — so a terminal reached through the hub
  // survives. This is the same "never prune a crossing" rule the move-ordering already enforces, applied to the
  // fan. It bounds the shape; which off-intent siblings matter semantically stays the (LLM) border's job.
  const hubGate = (opts.hubGate ?? _envFlag(process.env.SEAM_HUB_GATE) ?? false) && wave;
  const hubFan = Math.max(2, opts.hubFan ?? (parseInt(process.env.SEAM_HUB_FAN ?? "12", 10) || 12));   // fan width that marks a hub
  const hubFanned = new Set<string>();   // node ids belonging to a gated hub fan — cropped + never re-expanded
  // UBIQUITY PRIOR (wave, opt-in via SEAM_UBIQUITY / opts.ubiquity) — a DETERMINISTIC cross-module fan-in read
  // from the reverse-import index (grow/ubiquity.ts): a node reached from ≥`ubiquityFan` DISTINCT modules is
  // shared infrastructure. It (a) DEMOTES such a node in the frontier order (grow it last) and (b) STOPS the
  // flood from expanding THROUGH it — but ONLY when it bears NO grounded crossing (I4: a shared DAO on the
  // flow's crossing is scored high yet never gated). Off / no index → empty → no effect (I1/I3).
  const ubiquity = (opts.ubiquity ?? _envFlag(process.env.SEAM_UBIQUITY) ?? false) && wave;
  const ubiquityFan = Math.max(2, opts.ubiquityFan ?? (parseInt(process.env.SEAM_UBIQUITY_FAN ?? "12", 10) || 12));
  // RESIDUAL-BAND SLM (Phase 3, opt-in via SEAM_GROW_BORDER_RESIDUAL / opts.borderResidual). Only meaningful
  // when the LLM border is on: it deterministically auto-decides the confident ends of each ring (crossing /
  // field ≥ hi → keep; ubiquity-gated + field ≤ lo → drop) so the SLM judges only the ambiguous middle. hi/lo
  // are SLM-agreement-calibrated on the fixture (env-overridable; author-repo recalibration pending). The band
  // needs the intent field AND the ubiquity index, so both are computed here even when their own flags are off.
  const borderResidual = llmPrune && (opts.borderResidual ?? _envFlag(process.env.SEAM_GROW_BORDER_RESIDUAL) ?? false);
  const _num = (v: any, d: number): number => { const n = typeof v === "number" ? v : parseFloat(v ?? ""); return Number.isFinite(n) ? n : d; };
  const bandHi = _num(opts.borderHi ?? process.env.SEAM_GROW_BORDER_HI, 0.34);
  const bandLo = _num(opts.borderLo ?? process.env.SEAM_GROW_BORDER_LO, 0.20);
  const needUbiq = ubiquity || borderResidual;
  const ubiqScore = needUbiq ? await ubiquityIndex(repo, coStruct.ctx as EngineCtx) : null;
  // NOTE (auto-KEEP is EDGE-visible crossings only, NOT the file-level floor): a floor key marks a file that
  // TOUCHES a table, but an off-intent PEER reader of the same table (a reporting view reading `bookings`)
  // also touches it — auto-keeping by floor key over-keeps those peers and cut precision on the fixture. A
  // MATERIALISED crossing edge in the footprint is the on-intent signal; which same-table peer is on-intent
  // is semantic (the SLM's residual job). So crossings auto-keep via `bearers` (edges) + `n.coupling` only.
  const bandCtx: BandCtx | undefined = borderResidual
    ? { field: (n: any) => _iscore(n), ubiquity: (n: any) => ubiquityOf(ubiqScore!, n.file), hi: bandHi, lo: bandLo, fan: ubiquityFan }
    : undefined;
  let moveNo = 0;
  // WAVEFRONT termination is the BORDER (a wave that adds nothing — region fully flooded), NOT a wave count, so
  // the maxSteps cap is dropped in wave mode; maxNodes stays only as a runaway safety backstop. Single-pick keeps
  // maxSteps (its budget is the move count).
  for (let step = 0; (wave || step < maxSteps) && data.nodes.length < maxNodes; step++) {
    if (wave && (!llmPrune || borderResidual)) { await densify(); _growCentroid(step); }   // embedding field for the tol border + ordering (+ the residual band's intent field); the plain LLM prune needs neither
    const g = from_resolved_graph(data);
    assign_roles(g);
    const roleById = new Map([...g.nodes.values()].map((n: any) => [n.id, n.role]));
    const crossings = new Set<string>();
    for (const e of g.resolved_edges()) if (_is_crossing(e)) crossings.add(e.dst);
    // UBIQUITY hub test (I4-safe). `crossings` above is dst-only; broaden to BOTH endpoints (+ flow-subjects /
    // coupling nodes) so a node that BEARS a grounded crossing is never treated as a shared hub — it may be
    // scored high (a widely-consumed DAO), yet it is on the flow's crossing, so it is neither demoted nor gated.
    const crossingBearers = new Set<string>();
    if (ubiquity) for (const e of data.edges as any[]) if (_is_crossing(e)) { crossingBearers.add(e.dst); crossingBearers.add(e.from); }
    const isHub = (n: any): boolean => ubiquity && ubiquityOf(ubiqScore!, n.file) >= ubiquityFan
      && !crossingBearers.has(n.id) && !isFlowSubject(n.kind) && !n.coupling;
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
    // SOFT INTENT-BORDER — the SHAPE: nodes reachable from the anchor along a path whose embedding relevance never
    // falls more than `borderTol` below the path's high-water mark. Flood toward MORE-relevant nodes freely,
    // tolerate a shallow dip (a low-embedding bridge that recovers), HALT at a relevance cliff. Fixpoint
    // relaxation over the field (deterministic / order-independent). No tol or no embeddings → every node in-shape.
    let inShape: Set<string> | null = null;
    if (llmPrune) {
      // VALIDATED border: one cheap LLM call per wave judges the new ring; only in-scope nodes flood through.
      // Pass `repo` so a class candidate's methods can be read from source (its `contains` children aren't grown
      // yet at frontier time) — the judge sees `BookingsBean {createBooking, …}`, not a bare class name.
      inShape = await _llmPruneInShape(data, anchorId, { ...opts, repo }, decided, bandCtx);
    } else if (borderTol != null) {
      const scoreById = new Map<string, number>((data.nodes as any[]).map((n) => [n.id, _fieldScore(n)]));
      const peak = new Map<string, number>([[anchorId, scoreById.get(anchorId) ?? 0]]);
      for (let pass = 0, changed = true; changed && pass <= data.nodes.length; pass++) {
        changed = false;
        for (const [u, nbrs] of adj) {
          const pu = peak.get(u); if (pu == null) continue;
          for (const v of nbrs) {
            if (pu - (scoreById.get(v) ?? 0) > borderTol) continue;          // a cliff DOWN from the high-water mark
            const np = Math.max(scoreById.get(v) ?? 0, pu);                  // carry the high-water mark forward
            if (np > (peak.get(v) ?? -Infinity)) { peak.set(v, np); changed = true; }
          }
        }
      }
      inShape = new Set(peak.keys());
      dbg(`[grow] soft border (tol=${borderTol}): shape=${inShape.size}/${data.nodes.length} node(s)`);
    }
    // GROUNDED REACH — don't flood THROUGH a node reachable only via a bare-name receiver-agnostic `call` match
    // (RESOLVED_PARTIAL / SUGGESTED: honest ambiguity — core/resolution.ts says a PARTIAL link must not be
    // FOLLOWED). Such a node is a method-name coincidence (a test class's `empty()`/`generate()` matching every
    // same-named call), surfaced as a lead but not part of the flow; without this the grow floods through every
    // `generate`/`replaceColors` that merely calls a same-named method. A grounded reach — RESOLVED_FULL, a
    // structural PARTIAL that isn't a bare-name call (interface-impl / dispatch), a coupling crossing, an import
    // — IS followed. Symmetric with _fanCouple's coupling-fan gate; recomputed per wave as grounded edges appear.
    const nameMatchEdge = (e: any) => (e.provenance === "RESOLVED_PARTIAL" || e.provenance === "SUGGESTED") && e.kind === "call";
    const grounded = new Set<string>([anchorId]);
    for (const e of data.edges as any[]) if (!nameMatchEdge(e)) { grounded.add(e.from); grounded.add(e.to); }
    // BIDIRECTIONAL MOVES — each reached node offers BOTH directions (a dependency may climb back UP to its other
    // consumers — the sibling entry points — not only descend). UP of a CORE node is still skipped (the central
    // seam is covered); DOWN of a core node is kept (the mechanism chain handler→service→repo→DB).
    const moves: Move[] = [];
    for (const n of data.nodes as any[]) {
      if (n.id === "n1" || n.id === anchorId || !n.file || !n.symbol || isFlowSubject(n.kind) || excludedFile(n.file)) continue;
      if (!grounded.has(n.id)) continue;             // reached only by a bare-name call match → surface it, don't flood through it
      if (inShape && !inShape.has(n.id)) continue;   // beyond the soft border → keep the node, but don't flood THROUGH it
      const isCore = roleById.get(n.id) === "core";
      const hub = isHub(n);   // UBIQUITY: a non-crossing shared hub (its CONSUMER fan is off-intent sibling entry points)
      for (const d of ["up", "down"] as const) {
        if (expanded.has(expKey(n, d))) continue;
        // Skip the UP-climb of a NEAR core node (the central seam — already covered, re-growing it is noise), but
        // ALLOW it for a FAR core node: a shared backend service reached deep in the walk, whose other consumers
        // are the SIBLING entry points (the second UI behind a second route). Distance is the discriminator.
        if (d === "up" && isCore && distOf(n.id) < _UPCLIMB_MIN_DIST) continue;
        // UBIQUITY: skip the UP-climb of a non-crossing shared hub — its consumers are off-intent sibling entry
        // points (the cross-module fan). DOWN is kept, so a terminal reached THROUGH the hub is never severed.
        if (d === "up" && hub) continue;
        moves.push({ node: n, dir: d });
      }
    }
    const ordered = _orderMoves(moves, crossings, _iscore, typeRefOnly, distOf, isHub);
    if (!ordered.length) break;
    if (!wave) {
      // SINGLE-PICK (default): the one best move this step; recompute the frontier next step.
      const move = ordered[0];
      expanded.add(expKey(move.node, move.dir));
      const r = await _applyMove(repo, data, move, `step ${step + 1}`, coStruct, prune, history);
      data = r.data;
    } else {
      // WAVEFRONT (flood): expand EVERY ready head this wave; the nodes it adds become the next wave's frontier.
      // Heads are taken in relevance order, so a node budget fills the most-relevant region first. The recompute
      // above ran ONCE for this whole wave (not per move) — the perf win over single-pick.
      let waveAdded = 0;
      for (const move of ordered) {
        if (data.nodes.length >= maxNodes) break;
        const k = expKey(move.node, move.dir);
        if (expanded.has(k)) continue;
        expanded.add(k);
        const before = hubGate ? new Set<string>((data.nodes as any[]).map((n) => n.id)) : null;
        const r = await _applyMove(repo, data, move, `wave ${step + 1}·${++moveNo}`, coStruct, prune, history);
        data = r.data;
        waveAdded += r.added;
        // HUB GATE: this move added a wide fan — is it a PURE (non-spine) hub fan, or does it bear a crossing?
        if (hubGate && before && r.added >= hubFan) {
          const addedIds = (data.nodes as any[]).filter((n) => !before.has(n.id)).map((n: any) => n.id);
          const crossDst = new Set<string>();
          for (const e of data.edges as any[]) if (_is_crossing(e)) { crossDst.add(e.dst); crossDst.add(e.from); }
          const kindById = new Map<string, string>((data.nodes as any[]).map((n: any) => [n.id, n.kind]));
          const spineWard = addedIds.some((id: string) =>
            crossDst.has(id) || isFlowSubject(kindById.get(id) ?? "") || (data.nodes as any[]).find((n: any) => n.id === id)?.coupling);
          if (!spineWard) {   // off-intent hub fan → crop it and don't let it seed the next wave
            for (const id of addedIds) {
              hubFanned.add(id);
              const nn = (data.nodes as any[]).find((n: any) => n.id === id);
              if (nn) { expanded.add(expKey(nn, "up")); expanded.add(expKey(nn, "down")); }
            }
            dbg(`[grow] hub-gate: ${move.node.symbol} ${move.dir} fanned ${r.added} pure non-crossing consumer(s) → gated`);
          }
        }
      }
      if (!waveAdded) break;   // a whole wave added nothing new → the region is fully flooded
    }
  }
  // HUB-GATE CROP — remove the gated off-intent hub fans (kept out of the shape, like the border's ring crop).
  // Crossing/flow-subject fans were never marked, so a terminal reached through a hub is untouched here.
  if (hubGate && hubFanned.size) {
    const before = data.nodes.length;
    data.nodes = (data.nodes as any[]).filter((n) => !hubFanned.has(n.id));
    data.edges = (data.edges as any[]).filter((e) => !hubFanned.has(e.from) && !hubFanned.has(e.to));
    if (Array.isArray(data.blindspots)) data.blindspots = data.blindspots.filter((b: any) => !hubFanned.has(b.node));
    dbg(`[grow] hub-gate: cropped ${before} → ${data.nodes.length} node(s) (${hubFanned.size} off-intent hub-fan node(s) dropped)`);
  }
  // HONEST BACKSTOP — in wave mode the SOFT BORDER is the intended terminator; maxNodes is only a runaway safety
  // cap. If the flood hit it (a too-loose / absent border let the flood run to the cap), say so — a silently
  // truncated shape reads as complete. Single-pick's maxNodes IS its budget, so this is wave-only.
  if (wave && data.nodes.length >= maxNodes) {
    (data.blindspots ??= []).push({ node: data.anchor?.id ?? "n1", mechanism: "flood-safety-cap",
      evidence: `the wavefront flood hit the ${maxNodes}-node safety cap before settling at the intent border — the shape may be incomplete. Tighten the border (lower SEAM_GROW_BORDER_TOL) or raise the node cap (--max-nodes).`,
      candidates: [] });
  }
  // LLM-PRUNE: crop the footprint to the IN-SCOPE set. The border gated flood-THROUGH, but each in-scope node's
  // build_footprint still added its out-of-scope neighbours (the boundary RING), which dominate the node count on
  // a dense repo and read as "no discrimination". The SHAPE is the in-scope set, so drop the ring (out-of-scope +
  // never-judged). Judge the LAST wave's ring first (one final call) so a genuinely-in-scope node added on the
  // final wave isn't dropped unjudged. Boundary nodes (flow-subjects/coupling) the prune never sees are KEPT.
  if (llmPrune) {
    const aId = data.anchor?.id ?? "n1";
    await _llmPruneInShape(data, aId, { ...opts, repo }, decided, bandCtx);   // repo → class candidates judged WITH their methods
    const keep = new Set<string>([aId]);
    for (const n of data.nodes as any[]) { const v = decided.get(n.id); if (v === true || (v === undefined && (isFlowSubject(n.kind) || n.coupling))) keep.add(n.id); }
    const before = data.nodes.length;
    data.nodes = (data.nodes as any[]).filter((n) => keep.has(n.id));
    data.edges = (data.edges as any[]).filter((e) => keep.has(e.from) && keep.has(e.to));
    if (Array.isArray(data.blindspots)) data.blindspots = data.blindspots.filter((b: any) => keep.has(b.node));
    dbg(`[grow] llm-border: cropped ${before} → ${data.nodes.length} in-scope node(s)`);
    (data as any)._borderDecided = decided;   // hand the structural verdicts to the post-coupling border (reuse, don't re-ask)
  }
  // RANKING SIGNAL: when the LLM border judged the flood, IT is the intent signal — the kept footprint is
  // already intent-scoped. So the post-grow embedding RE-rank is redundant (and can mis-score what the LLM
  // correctly kept — the documented 0.11-on-a-real-mechanism-node case). Stamp it so the emit skips the
  // embedding pass and degrades exactly as it does when embeddings are absent (the LLM is the ranker now).
  if (llmPrune) (data as any).llmBorder = true;
  return [data, history];
}

// BORDER THE COUPLING OVERLAY (the intent gate the data-coupling fan bypasses). The structural border crops the
// flood to the intent, but the coupling overlay (P3 seed + deep) then fans every shared key/table the on-intent
// flow touches (`users`, `bookings`, `features`) out to ALL its consumers — auth, org, workflows, app-store,
// tests — and those complements were AUTO-KEPT, unjudged. So a clean 19-seam availability flow became 169. Run
// the SAME intent border over the coupling complements, REUSING the structural verdicts (only the new coupling
// nodes are LLM-judged), and drop the off-intent crossings. The boundary markers (flow-subjects) stay — they
// anchor a kept crossing; a marker whose complement was dropped is pruned by the dangling-edge filter downstream.
export async function _borderCoupling(data: any, opts: any, decided: Map<string, boolean>): Promise<void> {
  const aId = data.anchor?.id ?? "n1";
  const before = data.nodes.length;
  await _llmPruneInShape(data, aId, opts, decided);   // judges the as-yet-undecided coupling complements (structural reused)
  const keep = new Set<string>([aId]);
  for (const n of data.nodes as any[]) { const v = decided.get(n.id); if (v === true || (v === undefined && isFlowSubject(n.kind))) keep.add(n.id); }
  data.nodes = (data.nodes as any[]).filter((n) => keep.has(n.id));
  data.edges = (data.edges as any[]).filter((e) => keep.has(e.from) && keep.has(e.to));
  if (Array.isArray(data.blindspots)) data.blindspots = data.blindspots.filter((b: any) => keep.has(b.node));
  dbg(`[grow] coupling-border: cropped ${before} → ${data.nodes.length} node(s) (off-intent crossings pruned)`);
}

// ORCHESTRATOR — the phases in order (docs/grow-architecture.md). Each is a Footprint→Footprint with a single
// concern, so a bad footprint is localisable to one phase. P4 (relevance/prune) is still partly inside P2's
// frontier today (the Step-2 split); P5 (decompose) is the caller. Behaviour is pinned by grow_contract.test.
export async function grow_to_terminals(repo: string, anchorFile: string, symbol: string,
    opts: { maxSteps?: number; maxNodes?: number; bidirectional?: boolean; dataCoupling?: boolean; dataCouplingLlm?: boolean; model?: string; claudeBin?: string | null; flagTruncation?: boolean; intent?: string; excludeDirs?: string[]; includeTests?: boolean; ctx?: EngineCtx; wave?: boolean; borderLlm?: boolean; hubGate?: boolean; hubFan?: number; ubiquity?: boolean; ubiquityFan?: number; borderField?: string; borderTol?: number | null; borderResidual?: boolean; borderHi?: number; borderLo?: number } = {}): Promise<[any, any[]]> {
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
  dbg(`[${_gtag(co.ctx)}] P1 seed ${symbol}: ${seedN - 1} structural node(s)${seedDeps ? ` (incl. ${seedDeps} dep(s) — entry point)` : " (consumers only)"}`);
  data = await _phaseCoupling(repo, anchorFile, data, opts, co, coStruct, prune, coupled);   // P3 coupling bridges (seed)
  dbg(`[${_gtag(co.ctx)}] P3 coupling: +${data.nodes.length - seedN} bridge node(s)`);
  const [grown, history] = await _phaseExpand(repo, data, opts, coStruct, prune, excludedFile, maxSteps, maxNodes);   // P2 expand
  data = grown;
  dbg(`[${_gtag(co.ctx)}] P2 expand: ${history.length} step(s) → ${data.nodes.length} node(s) total (budget ${maxSteps} steps / ${maxNodes} nodes)`);
  // P3 (deep) — couple the boundary files the bidirectional walk CLIMBED to (sibling resources reached during
  // expand, not in the seed), so their routes cross to their UIs. `coupled` skips the seed files already done.
  if (co.dataCoupling !== false) { const n0 = data.nodes.length; await _fanCouple(repo, data, opts, co.ctx, coupled); dbg(`[${_gtag(co.ctx)}] P3 deep-couple: +${data.nodes.length - n0} bridge node(s)`); }
  // #1 — INTENT-BORDER THE COUPLING OVERLAY: the seed+deep coupling fan bypassed the structural border (its
  // complements were auto-kept), drowning the on-intent flow in off-intent consumers of shared hub tables. Judge
  // them with the same border and drop the off-intent ones. Skip the throwaway stable-floor probe (its result is
  // discarded; only the real grow's footprint is rendered).
  if (co.dataCoupling !== false && (data as any).llmBorder && (data as any)._borderDecided && !co.ctx?.stableFloor)
    // pass `repo` so a route-complement CLASS (a handler like CompanyAdviserService reached over a shared route)
    // is judged WITH its methods ({advisers, deserialize, …} ≠ bookings), not a bare class name the weak SLM keeps.
    await _borderCoupling(data, { intent: opts.intent, model: opts.model, claudeBin: opts.claudeBin, repo }, (data as any)._borderDecided);
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

// FOOTPRINT-SCOPED grow (the `--data-coupling llm` path). A cheap deterministic FLOOR pre-grow yields the
// flow's files (across every module it spans); the real LLM grow then scopes its per-file coupling discovery
// to THOSE — bounded by the answer's size, cross-module complete — instead of the anchor's whole module.
// The probe's footprint is DISCARDED (only its files are kept). CRITICALLY, the probe's deterministic coupling
// still materialises complements, which DECREMENT the grow-wide consumable budgets (complement/key/synth) on
// the shared ctx. Left undone, the throwaway probe permanently STARVES the REAL grow's crossing materialisation
// (`crossBoundary` stops at `complementBudget <= 0`) — so a coupling-reached resource the floor found is
// INDEXED but never materialised into the answer. Snapshot + restore those budgets so the probe is free; the
// repo-wide index CACHES on ctx persist (built once), only the per-run consumable budgets reset.
export async function grow_footprint_scoped(repo: string, anchorFile: string, symbol: string,
    opts: { ctx: EngineCtx; [k: string]: any }): Promise<[any, any[]]> {
  const ctx = opts.ctx;
  emit("Floor pre-grow to scope coupling discovery to the footprint…");
  ctx.stableFloor = true;
  const budget0 = { complementBudget: ctx.complementBudget, keyBudget: ctx.keyBudget, synthBudget: ctx.synthBudget };
  const [floorData] = await grow_to_terminals(repo, anchorFile, symbol, { ...opts, dataCouplingLlm: false, ctx });
  ctx.stableFloor = false;
  ctx.complementBudget = budget0.complementBudget;   // RESTORE: the scoping probe must not starve the answer
  ctx.keyBudget = budget0.keyBudget;
  ctx.synthBudget = budget0.synthBudget;
  ctx.footprintFiles = new Set((floorData.nodes ?? []).map((n: any) => n.file).filter(Boolean) as string[]);
  process.stderr.write(`[data-coupling] footprint-scoped LLM discovery: ${ctx.footprintFiles.size} files across the flow (vs the anchor's whole module)\n`);
  return grow_to_terminals(repo, anchorFile, symbol, { ...opts, dataCouplingLlm: true, ctx });
}
