// The --query STRUCTURAL SHAPE handlers (ask/consumers/dependencies/refactor/impact/compare/neighborhood/
// contract/reaches) — split out of decompose.ts, which also carries the diff-mode pipeline and the
// (much larger) codebase/grow orchestration. Each handler validates its required flags, runs the shape's
// deterministic projector, renders it (llm-context or a one-line text summary), and optionally emits the
// seams JSON. The shared envelope (validate → project → format-branch → emit) repeats across handlers by
// design — each shape's text summary and required flags differ enough that a further table-driven merge
// would trade this file's readability for a thin abstraction; see ARCHITECTURE.md discussion in the
// commit that added this split.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { emit } from "../core/progress.js";
import { err, stamp } from "./util.js";
import { type Args } from "./args.js";

// Ask query — a natural-language question routed (by the LLM) to the right shape, then run. The honest
// front-end: it answers structural questions and routes lexical/semantic ones to grep/RAG. Emits whatever
// model the chosen shape produces (with the routing decision attached).
export async function runAsk(a: Args): Promise<number> {
  const { ask } = await import("../codebase/grow/route.js");
  emit(`Routing: "${a.ask}"…`);
  let res: any;
  try { res = await ask(a.repo, a.ask!, { model: a.model, claudeBin: a.claudeBin, skeleton: a.skeleton }); }
  catch (e) { err(`ask failed: ${(e as Error).message}`); }
  process.stdout.write(`[route:${res.shape}] ${res.reason}\n`);
  if (res.routedAway || !res.result) { process.stdout.write((res.guidance ?? "") + "\n"); return 0; }

  const model: any = res.result.mode ? res.result : { mode: "codebase", ...res.result };
  if (a.format === "llm-context" || a.format === "waves" || a.format === "scenarios") {
    const lc = await import("../codebase/llm_context.js");
    // the SET/deps/reaches/… shapes have no flood-wave structure, so `--format waves` only changes the flow view.
    const r = res.result.shape === "set" ? lc.renderConsumerSet
      : res.result.shape === "deps" ? lc.renderDependencySet
      : res.result.shape === "reaches" ? lc.renderReach
      : res.result.shape === "contract" ? lc.renderContract
      : res.result.shape === "impact" ? lc.renderImpact
      : res.result.shape === "refactor" ? lc.renderRefactorFacts
      : res.result.shape === "neighborhood" ? lc.renderNeighborhood
      : res.result.shape === "comparison" ? lc.renderComparison
      : a.format === "waves" ? lc.renderWaves            // flow → wave view (flood order)
      : a.format === "scenarios" ? lc.renderScenarios    // flow → per-scenario sequence diagrams
      : lc.renderLlmContext;                             // flow → the region renderer
    process.stdout.write(r(model) + "\n");
  }
  if (a.emitSeams) {
    model.routedShape = res.shape; model.routedReason = res.reason;
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Consumers-of SET query — the resolved callers of a symbol, projected from the consumers footprint and
// rendered as a SET (no spine, no LLM). Emits a `shape: "set"` model whose noStructure is honest: when no
// caller resolves, Seam says so and routes the asker to grep instead of asserting a structure that isn't
// there. Mirrors the codebase model envelope so --emit-seams clients stay compatible.
export async function runConsumerSet(a: Args, scan: typeof import("../codebase/scan/index.js")): Promise<number> {
  if (!a.symbol) err("--query consumers requires --symbol (the callee whose callers you want)");
  if (!a.anchorFile) err("--query consumers requires --center <file>[#symbol]");
  const { projectConsumerSet } = await import("../codebase/grow/project_set.js");
  const { renderConsumerSet } = await import("../codebase/llm_context.js");
  emit(`Resolving consumers of ${a.symbol}…`);
  let graph: any;
  try {
    graph = await scan.build_footprint(a.repo, a.anchorFile!, a.symbol!,
      { direction: "up", depth: a.depth, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin });
  } catch (e) { err(`consumer scan failed: ${(e as Error).message}`); }
  const set = projectConsumerSet(graph);
  // Opt-in name-grounded recall — adds UNVERIFIED leads (kept separate from verified members). The floor
  // is thin/absent for Ruby (global constants) and C/C++ (no #include parser), where callers still use the
  // exact symbol name; this recovers them deterministically. See codebase/scan/name_consumers.ts.
  if (a.recall === "name") {
    const { scan_name_consumers } = await import("../codebase/scan/up/name_consumers.js");
    const { attachRecalled } = await import("../codebase/grow/project_set.js");
    try { attachRecalled(set, await scan_name_consumers(a.repo, a.anchorFile!, a.symbol!)); }
    catch (e) { process.stderr.write(`name recall skipped: ${(e as Error).message}\n`); }
  }
  const model: any = { mode: "codebase", ...set };

  if (a.format === "llm-context") process.stdout.write(renderConsumerSet(model) + "\n");
  else {
    const resolved = set.members.filter((m) => m.provenance !== "SUGGESTED").length;
    const suggested = set.members.length - resolved;
    const nRecalled = set.recalled?.length ?? 0;
    const recalled = nRecalled ? `, ${nRecalled} recalled (name-grounded, unverified)` : "";
    if (set.noStructure)
      process.stdout.write(`Consumers of '${set.anchor.symbol}': no resolved callers (${set.reason})${recalled}. `
        + (nRecalled ? "Verify the recalled leads — the import-based floor couldn't ground them.\n"
          : set.reason === "opaque" ? "Callers are statically opaque — use grep/LSP.\n"
          : "No caller found (entry point, dead, or dispatched-only).\n"));
    else
      process.stdout.write(`Consumers of '${set.anchor.symbol}': ${resolved} resolved`
        + (suggested ? `, ${suggested} suggested` : "") + (set.unresolved.length ? `, ${set.unresolved.length} unresolved (grep these)` : "") + recalled + "\n");
  }
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Dependencies query — the symmetric peer of consumers: the resolved OUT-edges of a symbol (what it
// uses), from a DOWN footprint, rendered as a `shape: "deps"` SET. Same honest `noStructure` (reason
// `none` = a leaf with no deps). No name-recall — dependencies are the anchor's own resolved out-edges.
export async function runDependencySet(a: Args, scan: typeof import("../codebase/scan/index.js")): Promise<number> {
  if (!a.symbol) err("--query dependencies requires --symbol (whose dependencies you want)");
  if (!a.anchorFile) err("--query dependencies requires --center <file>[#symbol]");
  const { projectDependencySet } = await import("../codebase/grow/project_set.js");
  const { renderDependencySet } = await import("../codebase/llm_context.js");
  emit(`Resolving dependencies of ${a.symbol}…`);
  let graph: any;
  try {
    graph = await scan.build_footprint(a.repo, a.anchorFile!, a.symbol!,
      { direction: "down", depth: a.depth, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin });
  } catch (e) { err(`dependency scan failed: ${(e as Error).message}`); }
  const set = projectDependencySet(graph);
  const model: any = { mode: "codebase", ...set };

  if (a.format === "llm-context") process.stdout.write(renderDependencySet(model) + "\n");
  else {
    const resolved = set.members.filter((m) => m.provenance !== "SUGGESTED").length;
    const suggested = set.members.length - resolved;
    if (set.noStructure)
      process.stdout.write(`Dependencies of '${set.anchor.symbol}': none resolved (${set.reason}). `
        + (set.reason === "opaque" ? "Deps exist but are statically opaque — use grep/LSP.\n" : "A leaf — it uses nothing resolvable.\n"));
    else
      process.stdout.write(`Dependencies of '${set.anchor.symbol}': ${resolved} resolved`
        + (suggested ? `, ${suggested} suggested` : "") + (set.unresolved.length ? `, ${set.unresolved.length} unresolved (grep these)` : "") + "\n");
  }
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Refactor query — the FACTS bundle for "how to refactor X": impact + dependencies + contract in one
// run. A composition; emits a `shape: "refactor"` model. The change PLAN over the facts stays the caller's.
export async function runRefactorFacts(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query refactor requires --center <file>#<symbol>");
  const { gatherRefactorFacts } = await import("../codebase/grow/refactor_facts.js");
  const { renderRefactorFacts } = await import("../codebase/llm_context.js");
  emit(`Gathering refactor facts for ${a.symbol}…`);
  let rf: any;
  try { rf = await gatherRefactorFacts(a.repo, a.anchorFile!, a.symbol!, { model: a.model, claudeBin: a.claudeBin }); }
  catch (e) { err(`refactor facts failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...rf };

  if (a.format === "llm-context") process.stdout.write(renderRefactorFacts(model) + "\n");
  else
    process.stdout.write(`Refactor facts for '${rf.anchor.symbol}': impact ${rf.impact.total} across ${rf.impact.fileCount} file(s)`
      + `${rf.impact.gaps.length ? ` (${rf.impact.gaps.length} opaque gap(s))` : ""}, ${rf.dependencies.members.length} dependency(ies), `
      + `contract ${rf.contract.provides.length} provided/${rf.contract.unusedExports.length} unused — the change plan is yours to make.\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Impact query — the transitive blast radius of a symbol (who's affected if you change it). A non-grow
// shape; emits a `shape: "impact"` model. The refactoring safety net.
export async function runImpact(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query impact requires --center <file>#<symbol>");
  const { projectImpact } = await import("../codebase/grow/impact.js");
  const { renderImpact } = await import("../codebase/llm_context.js");
  emit(`Computing the impact of ${a.symbol}…`);
  let im: any;
  // The shared --depth defaults to 1 (a direct-consumer hop); impact is TRANSITIVE, so treat the default
  // as "use the impact default" and only honor an explicit deeper --depth. (depth 1 = find_consumers.)
  try { im = await projectImpact(a.repo, a.anchorFile!, a.symbol!, { depth: a.depth > 1 ? a.depth : undefined, dataCoupling: a.dataCoupling }); }
  catch (e) { err(`impact analysis failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...im };

  if (a.format === "llm-context") process.stdout.write(renderImpact(model) + "\n");
  else if (im.noStructure)
    process.stdout.write(`Impact of '${im.anchor.symbol}': isolated — no resolved consumers (${im.reason})${im.gaps.length ? `, ${im.gaps.length} opaque caller(s) to grep` : ""}.\n`);
  else
    process.stdout.write(`Impact of '${im.anchor.symbol}': ${im.total} symbol(s) across ${im.fileCount} file(s)`
      + `, ${im.surface.length} at the surface${im.gaps.length ? `, ${im.gaps.length} opaque gap(s)` : ""}${im.truncated ? " (truncated — ≥ shown)" : ""}\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Compare query — diff two symbols' dependency sets (shared / A-only / B-only). FROM = --symbol/--anchor-file,
// B = --to-symbol/--to-file. A non-grow shape; emits a `shape: "comparison"` model.
export async function runCompare(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query compare requires --center <file>#<symbol> (side A) + --to-file/--to-symbol (side B)");
  if (!(a.toSymbol && a.toFile)) err("--query compare requires --to-symbol and --to-file (anchor B)");
  const { projectCompare } = await import("../codebase/grow/compare.js");
  const { renderComparison } = await import("../codebase/llm_context.js");
  emit(`Comparing dependencies: ${a.symbol} vs ${a.toSymbol}…`);
  let c: any;
  try { c = await projectCompare(a.repo, a.anchorFile!, a.symbol!, a.toFile!, a.toSymbol!, { depth: a.depth, dataCoupling: a.dataCoupling }); }
  catch (e) { err(`comparison failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...c };

  if (a.format === "llm-context") process.stdout.write(renderComparison(model) + "\n");
  else if (c.noStructure)
    process.stdout.write(`${c.a.symbol} vs ${c.b.symbol}: neither has resolved dependencies — nothing to compare.\n`);
  else
    process.stdout.write(`${c.a.symbol} vs ${c.b.symbol}: ${c.shared.length} shared, ${c.aOnly.length} ${c.a.symbol}-only, `
      + `${c.bOnly.length} ${c.b.symbol}-only (similarity ${(c.similarity * 100).toFixed(0)}%)\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Neighborhood query — the cohesive subsystem around an anchor: a bounded ball + a weak-community
// core/periphery partition (file grain). A non-grow shape; emits a `shape: "neighborhood"` model.
export async function runNeighborhood(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query neighborhood requires --center <file>#<symbol>");
  const { projectNeighborhood } = await import("../codebase/grow/neighborhood.js");
  const { renderNeighborhood } = await import("../codebase/llm_context.js");
  emit(`Mapping the subsystem around ${a.symbol}…`);
  let n: any;
  try { n = await projectNeighborhood(a.repo, a.anchorFile!, a.symbol!, { depth: a.depth, dataCoupling: a.dataCoupling }); }
  catch (e) { err(`neighborhood mapping failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...n };

  if (a.format === "llm-context") process.stdout.write(renderNeighborhood(model) + "\n");
  else if (n.noStructure)
    process.stdout.write(`${n.anchor.symbol}: isolated — no cohesive subsystem (no cross-file edges).\n`);
  else
    process.stdout.write(`Subsystem around ${n.anchor.symbol}: ${n.coreFiles.length} core file(s)`
      + (n.peripheryFiles.length ? ` + ${n.peripheryFiles.length} periphery` : "")
      + `, cohesion ${(n.cohesion * 100).toFixed(0)}%, boundary cut ${n.boundaryCut} edge(s) [${n.hops} expanded]\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Contract query — a module's boundary: what crosses IN (used exports + consumers) and OUT (resolved
// imports), plus fan-in/out. A non-grow shape; emits a `shape: "contract"` model.
export async function runContract(a: Args): Promise<number> {
  if (!a.anchorFile) err("--query contract requires --center <file> (the module)");
  const { projectContract } = await import("../codebase/grow/contract.js");
  const { renderContract } = await import("../codebase/llm_context.js");
  emit(`Mapping the contract of ${basename(a.anchorFile!)}…`);
  let c: any;
  try { c = await projectContract(a.repo, a.anchorFile!, { model: a.model, claudeBin: a.claudeBin }); }
  catch (e) { err(`contract mapping failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...c };

  if (a.format === "llm-context") process.stdout.write(renderContract(model) + "\n");
  else if (c.noStructure)
    process.stdout.write(`${basename(c.module)}: no exported members — no contract to describe.\n`);
  else
    process.stdout.write(`${basename(c.module)}: provides ${c.provides.length} (used), ${c.unusedExports.length} unused export(s); `
      + `depends on ${c.depends.length} external symbol(s) | fan-in ${c.afferent}, fan-out ${c.efferent}\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

// Reachability query — "can FROM reach TO?" answered as a verified yes/no + a witness path of resolved
// edges (a bounded BFS over dependency footprints). A non-grow shape; emits a `shape: "reaches"` model.
export async function runReaches(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query reaches requires --center <file>#<symbol> (the FROM) + --to-symbol (the TO)");
  if (!a.toSymbol) err("--query reaches requires --to-symbol (the TARGET)");
  const { findReach } = await import("../codebase/grow/reach.js");
  const { renderReach } = await import("../codebase/llm_context.js");
  emit(`Searching for a path ${a.symbol} → ${a.toSymbol}…`);
  let res: any;
  try { res = await findReach(a.repo, a.anchorFile!, a.symbol!, a.toSymbol!, { toFile: a.toFile, maxHops: a.maxHops, dataCoupling: a.dataCoupling }); }
  catch (e) { err(`reachability search failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...res };

  if (a.format === "llm-context") process.stdout.write(renderReach(model) + "\n");
  else if (res.reachable)
    process.stdout.write(`${res.from.symbol} → ${res.to.symbol}: REACHABLE in ${res.path.length - 1} hop(s) [${res.hops} explored]\n  `
      + res.path.map((s: any) => s.symbol).join(" → ") + "\n");
  else
    process.stdout.write(`${res.from.symbol} → ${res.to.symbol}: ${res.reason === "exhausted" ? "NOT FOUND within budget (inconclusive)" : res.reason === "no-out-edges" ? "FROM has no resolved dependencies (undefined)" : "UNREACHABLE (no resolved path)"} [${res.hops} explored]\n`);
  if (a.emitSeams) {
    writeFileSync(a.emitSeams, JSON.stringify(stamp(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}
