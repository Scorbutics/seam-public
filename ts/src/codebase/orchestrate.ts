// Port of src/codebase/orchestrate.py — P5 LLM-directional auto-orchestration: GROW a footprint
// toward answering a question. Seed from a confirmed anchor, then LOOP: show the LLM the current
// footprint + the question, let it pick ONE node and a DIRECTION (up = consumers / down = deps) that
// advances toward the answer, expand+merge, repeat — until done or a step budget. The LLM only
// CHOOSES moves over the deterministic primitives; it never invents an edge.
import { run_pass, ClassifierError as LLMError } from "../core/llm.js";
import { emit } from "../core/progress.js";
import { from_resolved_graph } from "../core/graph_ir.js";
import { assign_roles, _is_crossing } from "./codebase.js";
import { _key, merge_resolved } from "./expand.js";
import { build_consumers_graph, build_dependency_graph, build_bidirectional_graph } from "./import_scan.js";
import { KEY_NODE_KINDS } from "./coupling/index.js";

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

const _MOVE_CAP = 30;   // a single move adding more than this is "too broad" (a widely-used class) → skipped

// Seed from the anchor, then let the LLM grow the footprint toward `intent` for up to `maxSteps`.
// Returns [the grown ResolvedGraph, the move history]. A move that would add more than `_MOVE_CAP`
// nodes is SKIPPED — it floods the footprint instead of advancing the answer. Degrades to whatever
// it has grown if the LLM is unavailable / unusable.
export async function auto_orchestrate(repo: string, anchorFile: string, symbol: string, intent: string,
    opts: { maxSteps?: number; model?: string; claudeBin?: string | null; dataCoupling?: boolean; dataCouplingLlm?: boolean } = {}): Promise<[any, any[]]> {
  const maxSteps = opts.maxSteps ?? 4;
  const model = opts.model ?? "claude-haiku-4-5";
  const dataCoupling = opts.dataCoupling, dataCouplingLlm = opts.dataCouplingLlm, claudeBin = opts.claudeBin;
  let data: any = await build_consumers_graph(repo, anchorFile, symbol, { dataCoupling, dataCouplingLlm, model, claudeBin });
  const history: any[] = [];
  // Moves already followed, keyed `${symbol} ${up|down}`. The seed = build_consumers_graph already
  // expanded the ANCHOR's consumers, so its `up` starts expanded (re-picking it was the #1 wasted
  // move). A no-op move no longer ends the grow — we skip it and bail only once genuinely stuck, so
  // one bad pick can't strand the footprint short of the answer.
  const expanded = new Set<string>([`${symbol} up`]);
  const MAX_CONSEC_NOOP = 2;
  let consecNoop = 0;
  for (let _step = 0; _step < maxSteps; _step++) {
    emit(`Growing the footprint with the LLM (step ${_step + 1}/${maxSteps})…`);
    const summary = _summary(data);
    let out: Map<string, any>;
    try { out = run_pass(_step_prompt(intent, summary, expanded), { model, claudeBin: opts.claudeBin, tag: "orchestrate" }); }
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
      add = direction === "down"
        ? await build_dependency_graph(repo, nd.file, nd.symbol, { anchorLine: line, dataCoupling, dataCouplingLlm, model, claudeBin })
        : await build_consumers_graph(repo, nd.file, nd.symbol, { anchorLine: line, dataCoupling, dataCouplingLlm, model, claudeBin });
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
// discovery is complete & deterministic; relevance stays the one semantic (LLM) call.
export async function grow_to_terminals(repo: string, anchorFile: string, symbol: string,
    opts: { maxSteps?: number; maxNodes?: number; bidirectional?: boolean; dataCoupling?: boolean; dataCouplingLlm?: boolean; model?: string; claudeBin?: string | null } = {}): Promise<[any, any[]]> {
  const maxSteps = opts.maxSteps ?? 12, maxNodes = opts.maxNodes ?? 80;
  const co = { dataCoupling: opts.dataCoupling, dataCouplingLlm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin };
  // Bidirectional SEED (consumers + deps): a flow anchor's consumers reach its terminals, but an
  // ENTRY POINT (a route / webhook handler invoked by the framework) has NO in-repo consumers — its
  // work is DOWNSTREAM (deps). Seeding both directions means a source isn't a dead end, and the
  // `direction` tags let decompose detect the policy-vs-flow shape. Frontier growth stays consumer-ward.
  let data: any = opts.bidirectional
    ? await build_bidirectional_graph(repo, anchorFile, symbol, co)
    : await build_consumers_graph(repo, anchorFile, symbol, co);
  const history: any[] = [];
  const expanded = new Set<string>(data.nodes.filter((n: any) => n.id === "n1").map((n: any) => _key(n)));
  for (let step = 0; step < maxSteps && data.nodes.length < maxNodes; step++) {
    emit(`Growing the footprint to its terminals (step ${step + 1})…`);
    const g = from_resolved_graph(data);
    assign_roles(g);
    const roleById = new Map([...g.nodes.values()].map((n: any) => [n.id, n.role]));
    const crossings = new Set<string>();
    for (const e of g.resolved_edges()) if (_is_crossing(e)) crossings.add(e.dst);
    // frontier = a real symbol (not a boundary node, not a core) we haven't re-anchored yet; crossings first
    // (the data-flow chain toward terminals), then the largest remaining consumer.
    const cand = data.nodes.filter((n: any) => n.id !== "n1" && n.file && n.symbol
      && roleById.get(n.id) !== "core" && !KEY_NODE_KINDS.has(n.kind) && !expanded.has(_key(n)));
    cand.sort((a: any, b: any) => (Number(crossings.has(b.id)) - Number(crossings.has(a.id))) || ((b.complexity ?? 0) - (a.complexity ?? 0)));
    const next = cand[0];
    if (!next) break;
    expanded.add(_key(next));
    // DIRECTION-AWARE expansion: a CONSUMER (forward / untagged) extends UPSTREAM toward its terminals
    // (screens, entry points) via its own consumers; a DEPENDENCY (backward — from the bidirectional
    // seed) extends DOWNSTREAM toward the processing it drives via ITS deps. So an entry-point anchor
    // (a handler whose work is all downstream) traces the full path, not just its zero consumers.
    // Dep resolution is LOCAL (the file's imports) — cheap; consumers are the repo scan.
    const dir: string | undefined = next.direction;
    let add: any;
    try {
      add = dir === "backward"
        ? await build_dependency_graph(repo, next.file, next.symbol, { anchorLine: (next.range ?? [0])[0], ...co })
        : await build_consumers_graph(repo, next.file, next.symbol, { anchorLine: (next.range ?? [0])[0], ...co });
    } catch { history.push({ node: next.symbol, added: 0, skipped: "build failed" }); continue; }
    // a move that floods the footprint with non-coupling structure (a widely-used util) doesn't advance the
    // answer — data-coupling fan is exempt (self-bounded + the intent).
    const have = new Set(data.nodes.map((x: any) => _key(x)));
    const flood = add.nodes.filter((n: any) => !have.has(_key(n)) && !n.coupling).length;
    if (flood > _MOVE_CAP) { history.push({ node: next.symbol, added: 0, skipped: `too broad (+${flood})` }); continue; }
    // carry the grow direction outward so the chain keeps extending the same way (consumers further up,
    // deps further down); the seed tagged the anchor's two sides, this propagates past one hop.
    const tag = dir ?? "forward";
    for (const n of add.nodes) if (n.id !== add.anchor?.id && !n.direction) n.direction = tag;
    const before = data.nodes.length;
    data = merge_resolved(data, add, add.anchor?.id);
    history.push({ node: next.symbol, added: data.nodes.length - before, ...(dir === "backward" ? { dir: "down" } : {}) });
  }
  return [data, history];
}
