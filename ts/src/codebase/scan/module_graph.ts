// SCAN phase — the MODULE-anchor footprint: a whole file's EXPORTED members as nodes, their cross-file
// consumers, and the whole-file shared-key overlay (a front-end file with no exports/importers still
// couples to its backend via the routes/tables it touches). INTERNAL to the phase — the public entry is
// footprint.build_footprint (a null symbol routes here). Port of build_module_graph.
import { scan_module_consumers, _kind_for } from "../../core/resolve/consumers.js";
import { makeCtx, available, lang_for } from "../atoms.js";
import type { EngineCtx } from "../engine_ctx.js";
import { type GraphNode, type GraphEdge, type Blindspot, type ResolvedGraph, makeGraph } from "../graph.js";
import { expanduser, stem, _read, _named_units, _enclosing, _exported_members, _usage_lines } from "../ast_units.js";
import { _chain_route_consumers } from "./attach.js";

export async function build_module_graph(repo: string, anchorFile: string,
    opts: { dataCoupling?: boolean; dataCouplingLlm?: boolean; ctx?: EngineCtx; model?: string; claudeBin?: string | null } = {}): Promise<ResolvedGraph> {
  repo = expanduser(repo);
  const modName = stem(anchorFile);
  const ar = _read(repo, anchorFile);
  if (!ar || !available()) throw new Error(`cannot parse anchor module ${anchorFile}`);
  const ctx = (await makeCtx(ar[0], ar[1]))!;
  const members = _exported_members(ctx, anchorFile);
  const mlen = (ar[0].match(/\n/g) ?? []).length;
  const blindspots: Blindspot[] = [];
  const nodes: GraphNode[] = [{ id: "mod", symbol: modName, kind: "module", file: anchorFile, range: [0, mlen], enclosing: "", complexity: Math.max(1, mlen) }];
  for (const [name, kind, s, e] of members) nodes.push({ id: name, symbol: name, kind, file: anchorFile, range: [s, e], enclosing: modName, complexity: Math.max(1, e - s + 1) });

  const edges: GraphEdge[] = [];
  const memberNames = new Set(members.map((m) => m[0]));
  let counter = 0;
  for (const [cfile, used] of await scan_module_consumers(repo, anchorFile, memberNames)) {
    counter += 1;
    let sym = stem(cfile), kind = "module", rng: number[] = [0, 0];
    const rd = _read(repo, cfile);
    if (rd) {
      const cctx = await makeCtx(rd[0], rd[1]);
      if (cctx) {
        const units = _named_units(cctx);
        let line: number | null = null;
        for (const local of Object.values(used)) { const ul = _usage_lines(cctx, units, local); if (ul.length) { line = ul[0]; break; } }
        const enc = line != null ? _enclosing(units, line) : null;
        if (enc) { sym = enc[0]; kind = enc[1]; rng = [enc[2], enc[3]]; }
      }
    }
    const cid = `c${counter}`;
    nodes.push({ id: cid, symbol: sym, kind: _kind_for(cfile, kind), file: cfile, range: rng, enclosing: "", complexity: 1 });
    for (const mname of Object.keys(used).sort()) edges.push({ from: cid, to: mname, kind: "reference", provenance: "RESOLVED_FULL" });
  }

  // Shared-key boundary, WHOLE-FILE: a module's keys aren't tied to one export — a front-end file that
  // has no exports/importers (e.g. an AngularJS controller registered via `.controller(...)`, whose
  // `$http.get("/…")` lives inside an anonymous callback) is otherwise "isolated". Scan the whole file so
  // its route/table calls surface and couple to the backend that serves them.
  if (opts.dataCoupling !== false) {
    const dc = await import("../coupling/index.js");
    const dcDelta = await dc.resolveCoupling(repo, "mod", anchorFile, ar[0], 0, mlen, counter, { dataCoupling: true, llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, opts.ctx);
    nodes.push(...dcDelta.nodes); edges.push(...dcDelta.edges); blindspots.push(...dcDelta.blindspots); counter = dcDelta.counter;
    counter = await _chain_route_consumers(repo, nodes, edges, counter);
  }

  return makeGraph({ id: "mod", symbol: modName, file: anchorFile, range: [0, mlen] }, lang_for(anchorFile) ?? "", nodes, edges, { blindspots });
}
