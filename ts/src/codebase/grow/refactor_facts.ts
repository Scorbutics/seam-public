// COMPOSITION — the "refactor facts" bundle. "How to refactor X" splits into FACTS (structural) and a
// PLAN (judgement). The plan is the LLM's; this gathers the FACTS in one call so the model has the whole
// structural picture before planning a change to X:
//   impact       — the transitive blast radius (what breaks if X changes), the safety net
//   dependencies — what X uses (to preserve / rewire)
//   contract     — X's module boundary (what it promises + its outbound deps)
// It runs the three projections SEQUENTIALLY: build_footprint shares module-global scan caches, so
// gathering them concurrently corrupts results (the same hazard compare.ts hit). NOT a new analysis —
// just the existing shapes, composed; the renderer stitches their sections.
import { build_footprint } from "../scan/index.js";
import { projectImpact, type Impact } from "./impact.js";
import { projectDependencySet, type ConsumerSet } from "./project_set.js";
import { projectContract, type ModuleContract } from "./contract.js";

export interface RefactorFacts {
  shape: "refactor";
  anchor: { symbol: string; file: string };
  impact: Impact;
  dependencies: ConsumerSet;
  contract: ModuleContract;
}

export async function gatherRefactorFacts(
  repo: string, anchorFile: string, symbol: string,
  opts: { model?: string; claudeBin?: string | null } = {},
): Promise<RefactorFacts> {
  const impact = await projectImpact(repo, anchorFile, symbol, { dataCoupling: false });
  const depGraph = await build_footprint(repo, anchorFile, symbol, { direction: "down", dataCoupling: false });
  const dependencies = projectDependencySet(depGraph as any);
  const contract = await projectContract(repo, anchorFile, { model: opts.model, claudeBin: opts.claudeBin });
  return { shape: "refactor", anchor: { symbol, file: anchorFile }, impact, dependencies, contract };
}
