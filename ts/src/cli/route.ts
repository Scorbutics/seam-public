// SHAPE ROUTER (CLI side) — the semantic front-end that turns a natural-language question into the right Seam
// shape, then runs it.
//
// The DECISION lives in the Rust core: `routePrompt` builds the prompt from the core's SHAPES registry and
// `routeParse` validates the reply against that same registry, so the closed set of shapes has exactly one
// definition (rust/crates/seam-shapes/src/route.rs) and `resolveName` is the core's deterministic def lookup.
// Byte-identical to the engine it replaced — pinned by rust/parity/route_recall.ts.
//
// What stays HERE is the LLM CALL and the DISPATCH. The call, because only this side can reach the HOST BUS
// (the VS Code extension injects the editor's own model through it), and pushing the spawn into the addon
// would silently kill that path. The dispatch, because it is CLI wiring — each branch is one addon shape
// call, except `flow`, which runs a grow and hands the graph to decompose().
import { run_pass_async, registerPass, ClassifierError as LLMError, available, get_host_bus } from "../core/llm.js";

const PASS = registerPass({ tag: "shape-route", tier: "strong", note: "route an NL question to the right Seam shape — semantic" });

export interface RouteDecision { shape: string; target?: string; target2?: string; reason: string }
export interface ResolvedName { symbol: string; file: string; kind: string; ambiguous: boolean }

const core = async (): Promise<any> => {
  const { loadAddon } = await import("../codebase/grow/rust_core.js");
  const addon = loadAddon();
  if (!addon) throw new Error("the Seam core (Rust addon) is not available — build it with `make -C rust`");
  return addon;
};

// The registered shape ids, in registry order — the closed set a router answer must name.
export const shapeIds = async (): Promise<string[]> => (await core()).shapeIds();

// THE LLM JUDGEMENT: question + the core's registry hints → which shape + the extracted target name(s).
export async function routeQuestion(repo: string, question: string, opts: { model?: string; claudeBin?: string | null } = {}): Promise<RouteDecision | null> {
  const addon = await core();
  let out: Map<string, any>;
  try { out = await run_pass_async(addon.routePrompt(question), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag }); }
  catch (e) { if (e instanceof LLMError) return null; throw e; }
  return addon.routeParse(JSON.stringify([...out.values()])) ?? null;
}

// Resolve an extracted NAME to its definition (deterministic — a def lookup, NOT semantic).
export async function resolveName(repo: string, name: string): Promise<ResolvedName | null> {
  return (await core()).resolveName(repo, name) ?? null;
}

export interface AskResult {
  question: string;
  shape: string;
  reason: string;
  result?: any;          // the chosen shape's model (structural shapes)
  routedAway?: boolean;  // grep/rag — Seam declined; guidance explains where to go
  guidance?: string;     // why no structural result (route-away, or unresolved name)
}

// END-TO-END: route the question, resolve names, run the chosen shape. Requires an LLM (the routing is
// semantic). grep/rag → an honest route-away. A name that won't resolve → guidance, not a wrong answer.
export async function ask(repo: string, question: string, opts: { model?: string; claudeBin?: string | null; skeleton?: boolean } = {}): Promise<AskResult> {
  // Routing is semantic → needs a way to serve LLM passes: a host bus (the editor/inject bridge) OR a local
  // binary. available() alone misses the bus, which would wrongly reject the host-served path.
  if (!get_host_bus() && !available(opts.claudeBin)) throw new Error("the shape router needs an LLM backend (routing is semantic); none available");
  const decision = await routeQuestion(repo, question, opts);
  if (!decision) return { question, shape: "rag", reason: "router could not classify", routedAway: true, guidance: "Couldn't route this question to a shape — try grep or rephrase." };
  const { shape, target, target2, reason } = decision;

  if (shape === "grep") return { question, shape, reason, routedAway: true, guidance: "Lexical lookup — use grep/ripgrep; a structural shape would over-engineer a one-fact answer." };
  if (shape === "rag") return { question, shape, reason, routedAway: true, guidance: "Semantic-similarity question about meaning — use embeddings/RAG; resolved edges can't answer 'what is this about'." };

  if (!target) return { question, shape, reason, guidance: `Routed to '${shape}' but no target symbol could be extracted from the question.` };
  const a = await resolveName(repo, target);
  if (!a) return { question, shape, reason, guidance: `Routed to '${shape}' but '${target}' doesn't resolve to a definition in this repo.` };
  const amb = (r: ResolvedName) => r.ambiguous ? ` (note: '${r.symbol}' has multiple definitions; used ${r.file})` : "";

  const addon = await core();
  // The DTO→model adapters are the SHAPE HANDLERS' own (queries.ts) — the same wiring `--query <shape>` runs,
  // so a routed answer and a directly-asked one cannot drift apart.
  const q = await import("./queries.js");

  let result: any;
  if (shape === "consumers") {
    result = q.rustSetToModel(addon.projectConsumerSet(repo, a.file, a.symbol, false, false));
  } else if (shape === "dependencies") {
    result = q.rustSetToModel(addon.projectDependencySet(repo, a.file, a.symbol, false));
  } else if (shape === "impact") {
    result = q.rustImpactToModel(addon.projectImpact(repo, a.file, a.symbol));
  } else if (shape === "refactor") {
    result = q.rustRefactorToModel(addon.gatherRefactorFacts(repo, a.file, a.symbol));
  } else if (shape === "neighborhood") {
    result = q.rustNeighborhoodToModel(addon.projectNeighborhood(repo, a.file, a.symbol));
  } else if (shape === "contract") {
    result = q.rustContractToModel(addon.projectContract(repo, a.file));
  } else if (shape === "reaches" || shape === "compare") {
    if (!target2) return { question, shape, reason, guidance: `'${shape}' needs a second symbol; none was extracted.` };
    const b = await resolveName(repo, target2);
    if (!b) return { question, shape, reason, guidance: `Second symbol '${target2}' doesn't resolve in this repo.` };
    result = shape === "reaches"
      ? q.rustReachToModel(addon.findReach(repo, a.file, a.symbol, b.symbol, b.file))
      : q.rustCompareToModel(addon.projectCompare(repo, a.file, a.symbol, b.file, b.symbol));
    return { question, shape, reason: reason + amb(a) + amb(b), result };
  } else if (shape === "flow") {
    const orch = await import("../codebase/grow/orchestrate.js");
    const { from_resolved_graph } = await import("../core/graph_ir.js");
    const { decompose } = await import("../codebase/codebase.js");
    const [data] = await orch.grow_to_terminals(repo, a.file, a.symbol, { bidirectional: true, model: opts.model, claudeBin: opts.claudeBin });
    const model: any = await decompose(from_resolved_graph(data), { repo, useLlm: true, intent: question, model: opts.model, claudeBin: opts.claudeBin, skeleton: opts.skeleton });
    model.autoGrown = true;
    result = model;
  }
  return { question, shape, reason: reason + amb(a), result };
}
