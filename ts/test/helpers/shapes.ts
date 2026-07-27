// THE SHAPE PROJECTORS, for tests — the TypeScript projectors are gone (the Rust core owns every shape), so
// these are their signatures over the addon plus the CLI's own DTO→model adapters. That is deliberately the
// SAME wiring `--query <shape>` runs, so a test asserts what the product actually emits.
//
// The tests importing this were written against the TypeScript projectors and their assertions are unchanged:
// each one was byte-identical to the core before the TypeScript was deleted (rust/parity/{impact,contract,
// reach,compare,neighborhood}.ts). Trailing options the callers leave unset become `null`, which is how the
// parity harnesses ran them — the core's defaults ARE the defaults those assertions were written against.
import { loadAddon } from "../../src/codebase/grow/rust_core.js";
import {
  rustImpactToModel, rustContractToModel, rustReachToModel,
  rustCompareToModel, rustNeighborhoodToModel, rustRefactorToModel,
} from "../../src/cli/queries.js";

const core = (): any => loadAddon();

export async function projectImpact(repo: string, file: string, symbol: string, opts: any = {}): Promise<any> {
  return rustImpactToModel(core().projectImpact(repo, file, symbol, opts.depth ?? null, opts.maxExpansions ?? null,
    opts.couplingOverlay ?? null, opts.llm ?? null, opts.model ?? null, opts.claudeBin ?? null));
}

export async function projectContract(repo: string, moduleFile: string, _opts: any = {}): Promise<any> {
  return rustContractToModel(core().projectContract(repo, moduleFile));
}

export async function findReach(repo: string, fromFile: string, fromSymbol: string, toSymbol: string, opts: any = {}): Promise<any> {
  return rustReachToModel(core().findReach(repo, fromFile, fromSymbol, toSymbol,
    opts.toFile ?? null, opts.maxHops ?? null, opts.couplingHops ?? null));
}

export async function projectCompare(repo: string, aFile: string, aSymbol: string, bFile: string, bSymbol: string, opts: any = {}): Promise<any> {
  return rustCompareToModel(core().projectCompare(repo, aFile, aSymbol, bFile, bSymbol, opts.depth ?? null));
}

export async function projectNeighborhood(repo: string, file: string, symbol: string, opts: any = {}): Promise<any> {
  return rustNeighborhoodToModel(core().projectNeighborhood(repo, file, symbol,
    opts.depth ?? null, opts.maxExpansions ?? null, opts.dataCoupling ?? null));
}

export async function gatherRefactorFacts(repo: string, file: string, symbol: string, _opts: any = {}): Promise<any> {
  return rustRefactorToModel(core().gatherRefactorFacts(repo, file, symbol));
}
