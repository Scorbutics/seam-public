// SHAPE ROUTER — the semantic front-end that turns a natural-language question into the right Seam shape.
// This is the piece that lets you ask Seam ANYTHING instead of picking --query yourself.
//
// Strict division of labour (CLAUDE.md): choosing the shape is a SEMANTIC judgement ("what does the user
// mean") → the LLM decides, NEVER keyword/regex matching. The SET of shapes is a closed STRUCTURAL list →
// sourced from the SHAPES registry below (the prompt is BUILT from it, so adding a shape updates the router
// automatically — no hardcoded list to keep in sync). Resolving an extracted NAME to its definition file
// is deterministic (a def lookup). And the router is honest: it routes a lexical question to grep and a
// semantic-similarity question to RAG rather than forcing a structural shape that can't answer.
import { run_pass_async, registerPass, ClassifierError as LLMError, available, get_host_bus } from "../../core/llm.js";
import { enumerate_defs } from "../scan/def_table.js";

const PASS = registerPass({ tag: "shape-route", tier: "strong", note: "route an NL question to the right Seam shape — semantic" });

// The closed set of routable answers. STRUCTURAL shapes run a projection; the two SINKS (grep/rag) are
// honest route-aways — Seam declining a question that isn't structural. `needs` drives target extraction.
export type ShapeId = "consumers" | "dependencies" | "impact" | "refactor" | "reaches" | "contract" | "neighborhood" | "compare" | "flow" | "grep" | "rag";
export interface ShapeSpec { id: ShapeId; needs: ("symbol" | "target" | "module")[]; hint: string }

export const SHAPES: ShapeSpec[] = [
  { id: "consumers", needs: ["symbol"], hint: "WHO CALLS / USES a symbol — its consumers/callers (find-usages, but resolved). Q: 'who calls X', 'what uses X', 'where is X used'." },
  { id: "dependencies", needs: ["symbol"], hint: "WHAT a symbol DEPENDS ON / calls / uses — its outgoing dependencies (the inverse of consumers). Q: 'what does X depend on', 'what does X call/use', 'what are X's dependencies'." },
  { id: "impact", needs: ["symbol"], hint: "THE TRANSITIVE BLAST RADIUS — everything affected if X changes (callers, their callers, …). Q: 'what breaks if I change X', 'what's affected by changing X', 'impact of X'." },
  { id: "refactor", needs: ["symbol"], hint: "REFACTOR FACTS — everything needed to PLAN a change to X in one shot: impact + dependencies + contract. Q: 'how to refactor X', 'how should I change X', 'what do I need to know to safely modify X'. (Returns facts; the plan is yours.)" },
  { id: "reaches", needs: ["symbol", "target"], hint: "CAN A REACH B — is there a path from one symbol to another (with a witness path); or is X dead. Q: 'does A reach B', 'can X end up calling Y', 'is X reachable'." },
  { id: "contract", needs: ["module"], hint: "A MODULE/FILE's BOUNDARY — its public surface (used exports + consumers), dead exports, and outbound deps. Q: 'what's the public API of file F', 'what does module M expose / depend on', 'what can I remove from F'." },
  { id: "neighborhood", needs: ["symbol"], hint: "THE COHESIVE SUBSYSTEM around a symbol — the cluster of files that move together. Q: 'what's the subsystem around X', 'what files belong with X', 'scope the module around X'." },
  { id: "compare", needs: ["symbol", "target"], hint: "HOW TWO SYMBOLS DIFFER by what they depend on (shared / each-only). Q: 'how does A differ from B', 'are A and B implemented the same way', 'compare X and Y'." },
  { id: "flow", needs: ["symbol"], hint: "HOW A FEATURE/FLOW WORKS end-to-end — the ordered spine across files (anchor → … → outcome). Q: 'how does X work', 'trace the flow of X', 'what happens when X'." },
  { id: "grep", needs: [], hint: "A LEXICAL one-fact lookup where a text match is enough — locating a string/definition, find a literal. Q: 'where is the string \"foo\"', 'find the TODO', 'what line defines X' (a single location). Route here; do NOT use a structural shape." },
  { id: "rag", needs: [], hint: "A SEMANTIC-SIMILARITY question about MEANING, not resolved edges — 'what code is ABOUT payments', 'find code similar to this', conceptual search. Route here; structure can't answer meaning." },
];

export interface RouteDecision { shape: ShapeId; target?: string; target2?: string; reason: string }

// THE LLM JUDGEMENT: question + the registry hints → which shape + the extracted target name(s). Prompt is
// built from SHAPES so it always reflects the registered set.
export async function routeQuestion(repo: string, question: string, opts: { model?: string; claudeBin?: string | null } = {}): Promise<RouteDecision | null> {
  const lines = [
    `A developer asks about a codebase: "${question}"`,
    "",
    "Pick the ONE shape that best answers it, and extract the symbol/file name(s) the question is about.",
    "Shapes:",
  ];
  for (const s of SHAPES) lines.push(`  ${s.id}: ${s.hint}`);
  lines.push(
    "",
    "Rules:",
    "- target = the PRIMARY symbol or file the question is about (a bare identifier — no quotes/parens).",
    "- target2 = the SECOND symbol, only for 'reaches' (the destination) and 'compare' (the other side).",
    "- For 'contract', target is the module/FILE name.",
    "- If a text match is enough → grep. If it's about MEANING/similarity → rag. Don't force a structural shape.",
    "- reason = one short clause on why this shape.",
    'Output ONLY a JSON array with one object whose "id" is the chosen shape:',
    '  [{"id":"<shape>","target":"<name|>","target2":"<name|>","reason":"<why>"}]');
  let out: Map<string, any>;
  try { out = await run_pass_async(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag }); }
  catch (e) { if (e instanceof LLMError) return null; throw e; }
  for (const v of out.values()) {
    const shape = String(v?.id ?? "").trim() as ShapeId;
    if (!SHAPES.some((s) => s.id === shape)) continue;
    const target = String(v?.target ?? "").trim() || undefined;
    const target2 = String(v?.target2 ?? "").trim() || undefined;
    return { shape, target, target2, reason: String(v?.reason ?? "").trim() };
  }
  return null;
}

export interface ResolvedName { symbol: string; file: string; kind: string; ambiguous: boolean }

// Resolve an extracted NAME to its definition (deterministic — a def lookup, NOT semantic). Exact name
// match, test files demoted, then the lexicographically-smallest file for stability; `ambiguous` flags a
// multi-definition name so the caller can surface it. A name that looks like a path resolves by filename.
export async function resolveName(repo: string, name: string): Promise<ResolvedName | null> {
  const defs = await enumerate_defs(repo);
  const norm = name.replace(/\(.*$/, "").trim();
  const isTest = (f: string) => /(\b|\/|_|\.)(test|spec|__tests__)(\b|\/|_|\.)/i.test(f);
  let hits = defs.filter((d) => d.name === norm);
  if (!hits.length) hits = defs.filter((d) => d.name.toLowerCase() === norm.toLowerCase());
  if (!hits.length) {                                   // maybe a file/module name, not a symbol
    const base = norm.split("/").pop()!.replace(/\.[a-z]+$/i, "").toLowerCase();
    const fileHit = defs.find((d) => d.file.toLowerCase().includes(`/${base}.`) || d.file.toLowerCase().endsWith(`${base}.ts`) || d.file.toLowerCase().endsWith(`${base}.rb`));
    if (fileHit) return { symbol: norm, file: fileHit.file, kind: "module", ambiguous: false };
    return null;
  }
  const ranked = hits.sort((a, b) => Number(isTest(a.file)) - Number(isTest(b.file)) || a.file.localeCompare(b.file));
  return { symbol: ranked[0].name, file: ranked[0].file, kind: ranked[0].kind, ambiguous: hits.length > 1 };
}

export interface AskResult {
  question: string;
  shape: ShapeId;
  reason: string;
  result?: any;          // the chosen shape's model (structural shapes)
  routedAway?: boolean;  // grep/rag — Seam declined; guidance explains where to go
  guidance?: string;     // why no structural result (route-away, or unresolved name)
}

// END-TO-END: route the question, resolve names, run the chosen shape. Requires an LLM (the routing is
// semantic). grep/rag → an honest route-away. A name that won't resolve → guidance, not a wrong answer.
export async function ask(repo: string, question: string, opts: { model?: string; claudeBin?: string | null; skeleton?: boolean } = {}): Promise<AskResult> {
  // Routing is semantic → needs a way to serve LLM passes: a host bus (the MCP sampling/inject bridge) OR
  // a local binary. available() alone misses the bus, which would wrongly reject the pure-sampling path.
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

  let result: any;
  if (shape === "consumers") {
    const { build_footprint } = await import("../scan/index.js");
    const { projectConsumerSet } = await import("./project_set.js");
    result = projectConsumerSet(await build_footprint(repo, a.file, a.symbol, { direction: "up", dataCoupling: false }) as any);
  } else if (shape === "dependencies") {
    const { build_footprint } = await import("../scan/index.js");
    const { projectDependencySet } = await import("./project_set.js");
    result = projectDependencySet(await build_footprint(repo, a.file, a.symbol, { direction: "down", dataCoupling: false }) as any);
  } else if (shape === "impact") {
    result = await (await import("./impact.js")).projectImpact(repo, a.file, a.symbol);
  } else if (shape === "refactor") {
    result = await (await import("./refactor_facts.js")).gatherRefactorFacts(repo, a.file, a.symbol, { model: opts.model, claudeBin: opts.claudeBin });
  } else if (shape === "neighborhood") {
    result = await (await import("./neighborhood.js")).projectNeighborhood(repo, a.file, a.symbol);
  } else if (shape === "contract") {
    result = await (await import("./contract.js")).projectContract(repo, a.file);
  } else if (shape === "reaches" || shape === "compare") {
    if (!target2) return { question, shape, reason, guidance: `'${shape}' needs a second symbol; none was extracted.` };
    const b = await resolveName(repo, target2);
    if (!b) return { question, shape, reason, guidance: `Second symbol '${target2}' doesn't resolve in this repo.` };
    result = shape === "reaches"
      ? await (await import("./reach.js")).findReach(repo, a.file, a.symbol, b.symbol, { toFile: b.file })
      : await (await import("./compare.js")).projectCompare(repo, a.file, a.symbol, b.file, b.symbol);
    return { question, shape, reason: reason + amb(a) + amb(b), result };
  } else if (shape === "flow") {
    const orch = await import("./orchestrate.js");
    const { from_resolved_graph } = await import("../../core/graph_ir.js");
    const { decompose } = await import("../codebase.js");
    const [data] = await orch.grow_to_terminals(repo, a.file, a.symbol, { bidirectional: true, model: opts.model, claudeBin: opts.claudeBin });
    const model: any = await decompose(from_resolved_graph(data), { repo, useLlm: true, intent: question, model: opts.model, claudeBin: opts.claudeBin, skeleton: opts.skeleton });
    model.autoGrown = true;
    result = model;
  }
  return { question, shape, reason: reason + amb(a), result };
}
