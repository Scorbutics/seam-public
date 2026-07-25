// SCAN phase — the ONE public footprint entry point. Picks the consumer / dependency / bidirectional /
// module builder from `opts.direction` (and a null symbol), so callers express intent as a parameter
// instead of choosing a function. This collapses the direction ternary that was previously duplicated
// across the orchestrator and the CLI.
import { merge_resolved } from "./expand.js";
import { requireAvailable } from "../../core/treesitter.js";
import type { FootprintOpts, ResolvedGraph } from "./graph.js";
import { build_consumers_graph } from "./up/consumers_graph.js";
import { build_dependency_graph } from "./down/dependency_graph.js";
import { build_module_graph } from "./module_graph.js";

// BIDIRECTIONAL footprint: the anchor's CONSUMERS (forward — where it's used / what it's enforced at)
// AND its DEPENDENCIES (backward — how it works / the mechanism it delegates to), in ONE graph, each
// node tagged with the direction it was reached from. The single-direction default answers "where is X
// used"; "how does X work" needs the backward slice (which the consumers-only view never shows). Intent
// then leads with one slice — see _detect_shape / the policy-vs-flow split in codebase.ts.
async function build_bidirectional_graph(repo: string, anchorFile: string, symbol: string, opts: FootprintOpts): Promise<ResolvedGraph> {
  const fwd = await build_consumers_graph(repo, anchorFile, symbol, opts);
  const bwd = await build_dependency_graph(repo, anchorFile, symbol, opts);
  // Tag by the slice each node came from — but PRESERVE a direction already set on a node. A coupling pass
  // can reach a route HANDLER on the forward (consumers) side yet mark it "backward" (its mechanism is
  // downstream — see crossBoundary/handlerEdge); clobbering that to "forward" would strand the handler's
  // deps (the @Inject'd bean) un-explored. So only fill in the direction where one isn't already present.
  for (const n of fwd.nodes) if (n.id !== "n1" && !n.direction) n.direction = "forward";
  for (const n of bwd.nodes) if (n.id !== "n1" && !n.direction) n.direction = "backward";
  return merge_resolved(fwd, bwd, "n1");   // anchor (n1) shared; deps merge in as backward-tagged nodes
}

// Build a footprint around (anchorFile, symbol). `direction` selects the slice (default "up" = consumers);
// a null/empty `symbol` builds the whole-module footprint. The builders read only the options that apply
// to them — see FootprintOpts.
export function build_footprint(repo: string, anchorFile: string, symbol: string | null, opts: FootprintOpts = {}): Promise<ResolvedGraph> {
  // A footprint IS the structural answer — with no parser the consumer/dependency builders skip every
  // candidate file and return the anchor alone, which renders as a confident "nothing calls this". Guard
  // the ONE public entry so no shape (consumers/dependencies/impact/reaches/grow/…) can emit that lie;
  // per-builder `available()` checks below stay as-is for the OPTIONAL enrichment they gate.
  requireAvailable(`the ${opts.direction ?? "up"} footprint of ${symbol ?? anchorFile}`);
  if (!symbol) return build_module_graph(repo, anchorFile, opts);
  switch (opts.direction ?? "up") {
    case "down": return build_dependency_graph(repo, anchorFile, symbol, opts);
    case "both": return build_bidirectional_graph(repo, anchorFile, symbol, opts);
    default:     return build_consumers_graph(repo, anchorFile, symbol, opts);
  }
}
