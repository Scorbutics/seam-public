// THE FOOTPRINT BUILDERS, for tests — the TypeScript scan layer is gone (the Rust core owns every footprint),
// so these are its signatures over the addon. Most tests importing this do NOT test the scan: they use it to
// build a graph and then assert about coupling, tiering or a projection. Repointing keeps those assertions;
// deleting them alongside the engine would have thrown away coverage of code that stays.
//
// Each builder was proven byte-identical before the TypeScript went — rust/parity/{consumersgraph,modulegraph,
// classgraph,depgraph,footprint_both,enrich,ripple}.ts.
//
// `dataCoupling` DEFAULTS TRUE here, as it did on every TypeScript entry point (`opts.dataCoupling !== false`).
// The addon's own parameters default to FALSE, because a SHAPE asks for structure-only. A shim that forwarded
// `?? null` would hand these tests a structural graph and fail every coupling assertion in them — and that is
// the same mistake that silently emptied module mode (see the module-graph overlay fix), so it is spelled out
// rather than left to the reader.
import { loadAddon, toResolvedGraph, toGraphDto } from "../../src/codebase/rust_core.js";

// `process.env` does NOT cross the napi boundary — the addon reads its own process environment. A test that
// sets SEAM_COPRODUCERS / SEAM_*_CAP and then calls a builder would otherwise measure the environment the
// process STARTED in, and "isolate the base crossing set" would isolate nothing. This is the same reason
// rust_core.ts syncs on every call; these helpers are entry points too, so they sync too.
const core = (): any => {
  const addon = loadAddon();
  addon.syncSeamEnv(Object.entries(process.env).filter(([k, v]) => k.startsWith("SEAM_") && v !== undefined) as [string, string][]);
  return addon;
};
const dc = (o: any) => o?.dataCoupling !== false;
const g = (dto: any, what: string): any => {
  // A footprint the core cannot build is an ERROR, not an empty graph — the TypeScript entry called
  // `requireAvailable` for exactly this reason: a library/MCP consumer must never receive a silent zero.
  if (!dto) throw new Error(`the footprint of ${what} could not be built (no vendored grammar for it?)`);
  return toResolvedGraph(dto);
};

export async function build_footprint(repo: string, anchorFile: string, symbol: string | null, opts: any = {}): Promise<any> {
  // GUARD THE ENTRY, as the TypeScript `build_footprint` did with `requireAvailable`. The core does NOT: an
  // anchor in a file it cannot parse still yields a well-formed graph containing only the anchor, which
  // renders as a confident "nothing calls this". The CLI is fenced by `rustShapeOk`/`rustCanParse`; a library
  // caller reaching the builder directly is not, so the fence is repeated here.
  if (!core().canParse(anchorFile)) throw new Error(`the footprint of ${symbol ?? anchorFile} could not be built (no vendored grammar for ${anchorFile})`);
  return g(core().buildFootprint(repo, anchorFile, symbol, opts.direction ?? "up", dc(opts),
    opts.depth ?? null, opts.anchorLine ?? null, null), symbol ?? anchorFile);
}

export async function build_consumers_graph(repo: string, anchorFile: string, symbol: string, opts: any = {}): Promise<any> {
  return g(core().buildConsumersGraph(repo, anchorFile, symbol, opts.anchorLine ?? null, dc(opts)), symbol);
}

export async function build_dependency_graph(repo: string, anchorFile: string, symbol: string, opts: any = {}): Promise<any> {
  return g(core().buildDependencyGraph(repo, anchorFile, symbol, opts.anchorLine ?? null, dc(opts)), symbol);
}

export async function build_class_graph(repo: string, anchorFile: string, className: string, opts: any = {}): Promise<any> {
  return g(core().buildClassGraph(repo, anchorFile, className, dc(opts)), className);
}

export async function build_module_graph(repo: string, anchorFile: string, opts: any = {}): Promise<any> {
  return g(core().buildModuleGraph(repo, anchorFile, dc(opts)), anchorFile);
}

export function merge_resolved(base: any, add: any, expandAnchor?: string | null): any {
  return toResolvedGraph(core().mergeResolved(toGraphDto(base), toGraphDto(add), expandAnchor ?? null));
}

export async function enumerate_defs(repo: string, limit = 4000, files?: Set<string>, opts: any = {}): Promise<any[]> {
  return core().enumerateDefs(repo, limit, files ? [...files] : null, opts.moduleDefs ?? false);
}

export function defs_in_file(rel: string, text: string, opts: any = {}): any[] {
  return core().defsInFile(rel, text, opts.moduleDef ?? false);
}

export async function impls_of(repo: string, name: string): Promise<{ cls: string; file: string }[]> {
  return (core().implsOfBatch(repo, [name])[0] as string[][]).map(([cls, file]) => ({ cls, file }));
}

export async function embedScoreDefs(repo: string, intent: string, files?: Set<string>): Promise<any[]> {
  return core().embedScoreDefs(repo, intent, files ? [...files] : null);
}

export async function embedScoreStrings(intent: string, values: string[]): Promise<Map<string, number>> {
  return new Map(Object.entries(core().embedScoreStrings(intent, values) as Record<string, number>));
}

// The embeddings live in the core; asking the old JS runtime would answer for an engine that no longer runs.
export async function transformersAvailable(): Promise<boolean> {
  try { return !!core()?.embedAvailable(); } catch { return false; }
}

// The scan layer exposed one memo-reset per index. The core invalidates every cache it owns in one call, so
// they all collapse to this.
export const resetCallIndex = (repo?: string): void => core().resetCaches(repo ?? null);
export const _resetImplIndexMem = resetCallIndex;
export const _resetDefTableMem = resetCallIndex;
export const _resetFootprintMirror = resetCallIndex;
