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
import { err, snippetReaderOf, stamp } from "./util.js";
import { type Args } from "./args.js";
// THE line contract (see grow/project_set.ts): every line the scan/coupling floor produces is 0-BASED; a line
// that will be RENDERED as `file:line` is 1-BASED. The writers/coupling shapes below project coupling-floor
// hits (`lineOf` = newline count → 0-based), so they convert HERE, exactly like every other shape.
import { to1 } from "../codebase/grow/project_set.js";

// ── STEP 4: ROUTING A SHAPE TO THE RUST CORE ───────────────────────────────────────────────────────────────
// The guard is the GROW's guard (orchestrate.ts), minus its intent condition — a `--query` shape is structural
// by definition, so the "an intent-shaped grow returns a different region there" hazard cannot arise. What DOES
// carry over verbatim is the language pair: the addon links only a subset of the grammars and an unparseable
// file degrades SILENTLY (empty scans, a well-formed answer that is simply missing things), so `rustCanParse`
// fences the ANCHOR and `rustCanServeRepo` fences everything the shape could REACH.
//
// A shape flips ONLY when its comparator is byte-identical, and the TS implementation stays as the oracle —
// this is a router, not a replacement. Any failure inside the addon falls through to TS rather than surfacing:
// a shape that cannot answer is worse than one that answers a little slower.
async function rustShapeOk(a: Args): Promise<any | null> {
  if (!a.anchorFile) return null;
  try {
    const { rustCoreEnabled, loadAddon, rustCanParse, rustCanServeRepo } = await import("../codebase/grow/rust_core.js");
    if (!rustCoreEnabled() || !rustCanParse(a.anchorFile) || !rustCanServeRepo(a.repo)) return null;
    return loadAddon();
  } catch { return null; }
}

// The Rust SET dto → the TS model shape. The members are already byte-identical (pinned by
// rust/parity/shapes_set.ts); only the anchor is spelled differently, and TS omits `noStructure`/`recalled`
// when they are absent rather than emitting falsy ones, which the renderers rely on.
// The DTO→model adapters. Each Rust shape carries the same DATA (pinned byte-identical by the harnesses in
// rust/parity) but spells its ANCHOR flat (`anchorSymbol`/`anchorFile`) where the TS model nests it, omits the
// `shape` tag the renderers switch on, and always emits `noStructure` where TS omits a falsy one. That is the
// whole difference, and it is exactly where a wired shape breaks — hence rust/parity/wired_shapes.ts compares
// the RENDER, not the projection.
const nz = (r: any): any => (r?.noStructure ? { noStructure: true, ...(r.reason ? { reason: r.reason } : {}) } : {});
const anchorOf = (r: any) => ({ symbol: r.anchorSymbol, file: r.anchorFile });

const rustImpactToModel = (r: any): any => ({
  shape: "impact", anchor: anchorOf(r), impacted: r.impacted, files: r.files, surface: r.surface,
  total: r.total, fileCount: r.fileCount, gaps: r.gaps, hops: r.hops, truncated: r.truncated,
  crossStack: r.crossStack ?? [], crossStackTruncations: r.crossStackTruncations ?? [], ...nz(r),
});
const rustContractToModel = (r: any): any => ({
  shape: "contract", module: r.module, provides: r.provides, unusedExports: r.unusedExports,
  depends: r.depends, afferent: r.afferent, efferent: r.efferent, ...nz(r),
});
const rustNeighborhoodToModel = (r: any): any => ({
  shape: "neighborhood", anchor: anchorOf(r), members: r.members, coreFiles: r.coreFiles,
  peripheryFiles: r.peripheryFiles, boundaryCut: r.boundaryCut, cohesion: r.cohesion, depth: r.depth,
  hops: r.hops, ...nz(r),
});
const rustCompareToModel = (r: any): any => ({
  shape: "comparison", a: { symbol: r.aSymbol, file: r.aFile }, b: { symbol: r.bSymbol, file: r.bFile },
  shared: r.shared, aOnly: r.aOnly, bOnly: r.bOnly, similarity: r.similarity, depth: r.depth, ...nz(r),
});
const rustReachToModel = (r: any): any => ({
  shape: "reaches", from: { symbol: r.fromSymbol, file: r.fromFile },
  // the TS model omits `file` on the TARGET when the caller named only a symbol — an absent file is "any file
  // with this symbol", and emitting `file: undefined` would render as a located target that was never asked for
  to: { symbol: r.toSymbol, ...(r.toFile ? { file: r.toFile } : {}) },
  reachable: r.reachable, path: r.path, hops: r.hops, reason: r.reason,
  // only when TRUE: the renderer prints "(via data coupling)" on its presence, and a falsy key would read as
  // "this was a call path" — the two claims are not interchangeable
  ...(r.viaCoupling ? { viaCoupling: true } : {}), ...nz(r),
});
const rustRefactorToModel = (r: any): any => ({
  shape: "refactor", anchor: anchorOf(r),
  impact: rustImpactToModel(r.impact), dependencies: rustSetToModel(r.dependencies), contract: rustContractToModel(r.contract),
});

const rustWritersToModel = (r: any): any => ({
  shape: "writers", anchor: anchorOf(r), members: r.members, unresolved: [], resolutionQuality: r.resolutionQuality,
  tables: r.tables, columnGrain: r.columnGrain,
  // napi has no map type, so the DTO carries `[[table, ...columns], …]`; the model wants `{table: [columns]}`
  filterColumns: Object.fromEntries((r.filterColumns ?? []).map((row: string[]) => [row[0], row.slice(1)])),
  ...nz(r),
});
const rustCouplingToModel = (r: any): any => ({
  shape: "coupling", anchor: anchorOf(r), keys: r.keys, total: r.total, ...nz(r),
});

const rustSetToModel = (r: any): any => ({
  shape: r.shape,
  anchor: { symbol: r.anchorSymbol, file: r.anchorFile },
  members: r.members,
  unresolved: r.unresolved,
  resolutionQuality: r.resolutionQuality,
  ...(r.recalled?.length ? { recalled: r.recalled } : {}),
  ...(r.noStructure ? { noStructure: true, reason: r.reason } : {}),
});

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
  if (a.format === "llm-context") {
    const lc = await import("../codebase/llm_context.js");
    const r = res.result.shape === "set" ? lc.renderConsumerSet
      : res.result.shape === "deps" ? lc.renderDependencySet
      : res.result.shape === "reaches" ? lc.renderReach
      : res.result.shape === "contract" ? lc.renderContract
      : res.result.shape === "impact" ? lc.renderImpact
      : res.result.shape === "refactor" ? lc.renderRefactorFacts
      : res.result.shape === "neighborhood" ? lc.renderNeighborhood
      : res.result.shape === "comparison" ? lc.renderComparison
      : lc.renderLlmContext;                             // flow → the region renderer
    process.stdout.write(r(model, await snippetReaderOf(a)) + "\n");
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
// CROSS-STACK COUPLING OVERLAY (the MOAT) — the anchor's shared-key readers/writers: a DB table / route / event it
// touches that another file reads/writes with NO import or call edge between them (a backend write whose frontend
// reader nothing links). ONE bounded, ctx-cached pass on the anchor SYMBOL (the same overlay `impact` uses) — O(1),
// keeps the structure-only footprint cache warm, and surfaces the non-textual coupling grep/RAG can't find. ON by
// default for consumers/dependencies; opt out with --no-data-coupling (a.dataCoupling=false). available()-gated → [].
export interface CrossStackCrossing { symbol: string; file: string; edgeKind: string; via: string }
export interface CouplingTruncation { kind: string; value: string; scanned: number; total: number; reason: string }
async function couplingOverlay(a: Args, exclude: Set<string>): Promise<{ crossStack: CrossStackCrossing[]; truncations: CouplingTruncation[] }> {
  const none = { crossStack: [] as CrossStackCrossing[], truncations: [] as CouplingTruncation[] };
  if (a.dataCoupling === false || !a.anchorFile || !a.symbol) return none;
  try {
    const { couplingOtherSides } = await import("../codebase/coupling/index.js");
    const { EngineCtx } = await import("../codebase/engine_ctx.js");
    const { available } = await import("../core/llm.js");
    // AUTO (default) → the LLM key-discovery FLYWHEEL when a backend is present (learn-once, cached → replayed
    // deterministically after), else the deterministic FLOOR. Explicit --data-coupling llm/floor overrides; SEAM_COUPLING=floor
    // forces determinism. Mirrors the grow's auto→llm resolution (decompose.ts) so the overlay's recall matches a grow's.
    const llm = a.dataCouplingLlm || (a.dataCouplingAuto && process.env.SEAM_COUPLING !== "floor" && available(a.claudeBin));
    const ctx = new EngineCtx();
    const sides = await couplingOtherSides(a.repo, a.anchorFile, a.symbol,
      { llm, model: a.model, claudeBin: a.claudeBin }, ctx);
    const seen = new Set<string>();
    const out: CrossStackCrossing[] = [];
    for (const s of sides) {
      const k = `${a.repo && ""}${s.file}#${s.symbol}`;
      if (seen.has(k) || exclude.has(`${s.file}#${s.symbol}`)) continue;   // don't repeat a structural code edge
      seen.add(k);
      out.push({ symbol: s.symbol, file: s.file, edgeKind: s.edgeKind, via: `${s.kind} ${s.value}` });
    }
    out.sort((x, y) => x.file.localeCompare(y.file) || x.symbol.localeCompare(y.symbol));
    return { crossStack: out, truncations: ctx.couplingTruncations.slice() };
  } catch { return none; }   // coupling unavailable (no tree-sitter) → the structural set is still complete
}

export async function runConsumerSet(a: Args, scan: typeof import("../codebase/scan/index.js")): Promise<number> {
  // Name the CURRENT address spelling (`--center <file>#<symbol>`), not the superseded --symbol: a bare
  // `--center <file>` lands here, and pointing at a flag the docs call obsolete leaves the caller stuck.
  if (!a.symbol) err("--query consumers requires a SYMBOL: --center <file>#<symbol> (the callee whose callers you want)");
  if (!a.anchorFile) err("--query consumers requires --center <file>#<symbol>");
  const { projectConsumerSet } = await import("../codebase/grow/project_set.js");
  const { renderConsumerSet } = await import("../codebase/llm_context.js");
  emit(`Resolving consumers of ${a.symbol}…`);
  // RUST FIRST when the guard allows it — the projection is byte-identical (rust/parity/shapes_set.ts) and the
  // addon builds the footprint itself, so this skips the TS scan entirely rather than just the projection.
  const rustAddon = await rustShapeOk(a);
  let set: any = null;
  if (rustAddon) {
    try { set = rustSetToModel(rustAddon.projectConsumerSet(a.repo, a.anchorFile!, a.symbol!, false)); }
    catch { set = null; }   // any addon failure → the TS path below, never a failed query
  }
  let graph: any;
  if (!set) try {
    // STRUCTURAL + CACHED, exactly like impact/reaches. A consumer SET is the anchor's resolved callers —
    // projectConsumerSet reads only the anchor's direct edges + blindspots, never the coupling overlay — so
    // running per-node data-coupling here was pure cost AND it disabled build_footprint_cached (which only
    // memoizes dataCoupling===false). That is why `consumers` was the one shape with NO warm benefit at all
    // (cal.com getBooking 14.9→12.8s, Keycloak UserStorageProvider 11.8→10.6s, flat over four passes, while
    // impact went 26s→0.7s). Coupling stays opt-in via an explicit --data-coupling.
    graph = await scan.build_footprint_cached(a.repo, a.anchorFile!, a.symbol!,
      { direction: "up", depth: a.depth, dataCoupling: a.dataCouplingExplicit ? a.dataCoupling : false, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin });
  } catch (e) { err(`consumer scan failed: ${(e as Error).message}`); }
  if (!set) set = projectConsumerSet(graph);
  // Opt-in name-grounded recall — adds UNVERIFIED leads (kept separate from verified members). The floor
  // is thin/absent for Ruby (global constants) and C/C++ (no #include parser), where callers still use the
  // exact symbol name; this recovers them deterministically. See codebase/scan/name_consumers.ts.
  if (a.recall === "name") {
    const { scan_name_consumers } = await import("../codebase/scan/up/name_consumers.js");
    const { attachRecalled } = await import("../codebase/grow/project_set.js");
    try { attachRecalled(set, await scan_name_consumers(a.repo, a.anchorFile!, a.symbol!)); }
    catch (e) { process.stderr.write(`name recall skipped: ${(e as Error).message}\n`); }
  }
  // CROSS-STACK MOAT — attach the anchor's shared-key readers/writers (the non-textual coupling), on by default.
  const overlay = await couplingOverlay(a, new Set(set.members.map((m: any) => `${m.file}#${m.symbol}`)));
  const model: any = { mode: "codebase", ...set, crossStack: overlay.crossStack, crossStackTruncations: overlay.truncations };

  if (a.format === "llm-context") process.stdout.write(renderConsumerSet(model, await snippetReaderOf(a)) + "\n");
  else {
    const resolved = set.members.filter((m: any) => m.provenance !== "SUGGESTED").length;
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
  if (!a.symbol) err("--query dependencies requires a SYMBOL: --center <file>#<symbol> (whose dependencies you want)");
  if (!a.anchorFile) err("--query dependencies requires --center <file>#<symbol>");
  const { projectDependencySet } = await import("../codebase/grow/project_set.js");
  const { renderDependencySet } = await import("../codebase/llm_context.js");
  emit(`Resolving dependencies of ${a.symbol}…`);
  // RUST FIRST — the symmetric peer of the consumers routing above; same guard, same byte-identical projection.
  const rustAddonD = await rustShapeOk(a);
  let set: any = null;
  if (rustAddonD) {
    try { set = rustSetToModel(rustAddonD.projectDependencySet(a.repo, a.anchorFile!, a.symbol!, false)); }
    catch { set = null; }
  }
  let graph: any;
  if (!set) try {
    // Same structural+cached treatment as consumers above — projectDependencySet reads the anchor's own
    // resolved out-edges, not the coupling overlay.
    graph = await scan.build_footprint_cached(a.repo, a.anchorFile!, a.symbol!,
      { direction: "down", depth: a.depth, dataCoupling: a.dataCouplingExplicit ? a.dataCoupling : false, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin });
  } catch (e) { err(`dependency scan failed: ${(e as Error).message}`); }
  if (!set) set = projectDependencySet(graph);
  // DI-BINDING ENRICHMENT (opt-in SEAM_DI_RESOLVE; TS/ioctopus): the deps graph already resolves interface→impl
  // edges but not WHICH impl a DI container binds, nor the runtime condition. Attach that binding to each member
  // that is a container-bound concrete impl, so the answer is complete in one query (no follow-up grep).
  if (process.env.SEAM_DI_RESOLVE !== "0") {   // DEFAULT-ON: agents never knew to set the flag, so the DI resolution silently never ran (observed: an agent reported "Seam did not print the selection condition" and read the module by hand). =0 kills it.
    const { diBindingForClass } = await import("../codebase/di/index.js");
    const { impls_of } = await import("../codebase/scan/down/interface_index.js");
    for (const m of set.members) {
      let b = await diBindingForClass(a.repo, m.symbol);   // member IS a container-bound concrete impl
      if (!b) {
        // …or member is an INTERFACE type-ref: chain the impl-index → its impl's binding, so the answer is
        // complete even when the concrete impls don't surface as their own members. impls_of is empty unless
        // `m.symbol` is a genuine in-repo interface, so this never fabricates a binding on a plain class.
        for (const im of await impls_of(a.repo, m.symbol)) {
          const ib = await diBindingForClass(a.repo, im.cls);
          if (ib) { b = ib; break; }
        }
      }
      if (b) m.binding = b;
    }
  }
  // CROSS-STACK MOAT — the anchor's data-coupling boundary (shared-key producers/readers it depends on), on by default.
  const overlay = await couplingOverlay(a, new Set(set.members.map((m: any) => `${m.file}#${m.symbol}`)));
  const model: any = { mode: "codebase", ...set, crossStack: overlay.crossStack, crossStackTruncations: overlay.truncations };

  if (a.format === "llm-context") process.stdout.write(renderDependencySet(model, await snippetReaderOf(a)) + "\n");
  else {
    const resolved = set.members.filter((m: any) => m.provenance !== "SUGGESTED").length;
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

// Writers query — REVERSE data-coupling: given a READ site (a method that reads a DB table), enumerate ALL the
// WRITE sites of that same table across the repo, deterministically. THE primitive that collapses the "who writes
// the shared state X reads" grep-discovery loop (observed: an agent grepped 8× just to find the write methods
// before it could hand a center to Seam) into ONE call. It reads the repo-wide coupling FLOOR producers directly
// (otherSide, uncapped) — NOT the coupling star, which caps the fan and blindspots repository-mediated writers.
// Table-grained (the floor keys tables, not columns), so it returns every writer of the table; the LLM crops to
// the intent-relevant ones (which is the LLM's job — Seam supplies the complete deterministic fact set).
export async function runWritersSet(a: Args, _scan: typeof import("../codebase/scan/index.js")): Promise<number> {
  if (!a.anchorFile) err("--query writers requires --center <file>[#symbol] (a read site whose table's writers you want)");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { floor_base_index, otherSide, scan_file_keys } = await import("../codebase/coupling/index.js");
  const { symbol_span, complement_unit, accessColumns } = await import("../codebase/coupling/bridge.js");
  const { EngineCtx } = await import("../codebase/engine_ctx.js");
  const { SKIP_DIRS } = await import("../core/resolve/languages/index.js");
  const { renderWritersSet } = await import("../codebase/llm_context.js");

  emit(`Resolving writers of the table(s) ${a.symbol ?? basename(a.anchorFile!)} reads…`);
  // RUST FIRST (see rustShapeOk) — the whole shape, floor scan included, is in the core.
  const rustA7 = await rustShapeOk(a);
  if (rustA7) {
    try {
      const model: any = { mode: "codebase", ...rustWritersToModel(rustA7.projectWriters(a.repo, a.anchorFile!, a.symbol ?? undefined)) };
      if (a.format === "llm-context") process.stdout.write(renderWritersSet(model, await snippetReaderOf(a)) + "\n");
      else if (model.noStructure && model.reason === "none")
        process.stdout.write(`Writers of what '${model.anchor.symbol}' reads: it reads no resolvable DB table (nothing to reverse-couple; use grep).\n`);
      else process.stdout.write(`Writers of ${model.tables.map((t: string) => `"${t}"`).join(", ")} (read by ${model.anchor.symbol}): ${model.members.length} write site(s).\n`);
      if (a.emitSeams) { writeFileSync(a.emitSeams, JSON.stringify(stamp(model))); process.stdout.write(`Seams: ${a.emitSeams}\n`); }
      return 0;
    } catch { /* fall through to the TS path — a shape that cannot answer is worse than a slower one */ }
  }
  let text: string;
  try { text = readFileSync(join(a.repo, a.anchorFile!), "utf-8"); } catch (e) { err(`cannot read center file: ${(e as Error).message}`); return 1; }

  // 1) the tables the CENTER reads (kind db-table, CONSUME role), scoped to the symbol's span when one is given.
  const span = a.symbol ? await symbol_span(a.repo, a.anchorFile!, a.symbol) : null;
  const inSpan = (line: number) => !span || (line >= span[0] && line <= span[1]);
  const readHits = scan_file_keys(a.anchorFile!, text).filter((h) => h.kind === "db-table" && !h.produces && inSpan(h.line));
  const readTables = [...new Set(readHits.map((h) => h.value))];

  const anchor = { symbol: a.symbol ?? basename(a.anchorFile!), file: a.anchorFile! };
  // COLUMN-GRAIN (default on; SEAM_WRITERS_COLUMNS=0 = table-level). Read BEFORE the empty early-return so the
  // model carries the same fields whether or not the answer is empty — a consumer should not have to special-case
  // the shape of an empty answer (the renderer reads `columnGrain`/`filterColumns` unconditionally).
  const colGrain = process.env.SEAM_WRITERS_COLUMNS !== "0";
  if (!readTables.length) {
    const model: any = { mode: "codebase", shape: "writers", anchor, members: [], unresolved: [],
      resolutionQuality: "FULL", tables: [], columnGrain: colGrain, filterColumns: {}, noStructure: true, reason: "none" };
    if (a.format === "llm-context") process.stdout.write(renderWritersSet(model, await snippetReaderOf(a)) + "\n");
    else process.stdout.write(`Writers of what '${anchor.symbol}' reads: it reads no resolvable DB table (nothing to reverse-couple; use grep).\n`);
    // An EMPTY answer is still an ANSWER, and `--emit-seams` is the programmatic caller's only channel: skipping
    // the write here left it unable to tell "this symbol reads no table" from "the query crashed" — no file
    // either way. Same honest-empty contract the shapes themselves keep.
    if (a.emitSeams) { writeFileSync(a.emitSeams, JSON.stringify(stamp(model))); process.stdout.write(`Seams: ${a.emitSeams}\n`); }
    return 0;
  }

  // 1b) COLUMN-GRAIN (default on; SEAM_WRITERS_COLUMNS=0 = table-level): the COLUMNS the center FILTERS on per table
  // (its `where` keys). A writer is kept only if it writes a column the reader filters on (that's what changes the
  // read's result); a writer whose columns we can't parse is KEPT but flagged unverified (never drop a real write).
  const parseCache = new Map<string, any>();
  const readerCols = new Map<string, Set<string>>();   // table -> columns the center's where-clauses filter on
  if (colGrain) for (const h of readHits) {
    const cols = (await accessColumns(a.repo, a.anchorFile!, h.line, parseCache)).reads;
    const set = readerCols.get(h.value) ?? new Set<string>();
    for (const c of cols) set.add(c);
    readerCols.set(h.value, set);
  }

  // 2) repo-wide coupling-FLOOR producers (writers) of each read table — uncapped; otherSide drops test/fixtures.
  const ctx = new EngineCtx();
  const idx = floor_base_index(a.repo, SKIP_DIRS, ctx);
  const seen = new Set<string>();
  const members: any[] = [];
  for (const table of readTables) {
    const filterCols = readerCols.get(table);   // undefined/empty ⇒ reader columns opaque → keep all (table-level)
    for (const w of otherSide(idx, "db-table", table, false)) {         // produces:false ⇒ the OTHER side = producers = writers
      const dedup0 = `${w.file}#${w.line}#${table}`;   // per-access guard for the column parse
      let columns: string[] = [], colVerified = false;
      if (colGrain && filterCols && filterCols.size) {
        const writeCols = (await accessColumns(a.repo, w.file, w.line, parseCache)).writes;
        if (writeCols.length) {
          columns = writeCols.filter((c) => filterCols.has(c));
          colVerified = true;
          if (!columns.length) continue;   // writes only columns the reader does NOT filter on → not coupled, DROP
        }   // else: opaque write args → keep, unverified (colVerified stays false)
      }
      const unit = await complement_unit(a.repo, w.file, w.line);
      const dedup = `${w.file}#${unit.symbol}#${table}`;
      if (seen.has(dedup)) continue;                                    // collapse a method's many write-lines to one member
      seen.add(dedup);
      members.push({ symbol: unit.symbol, file: w.file, line: to1(w.line), kind: unit.kind, enclosing: "", edgeKind: "db-write", provenance: "RESOLVED_PARTIAL", table, columns, colVerified });
    }
  }
  members.sort((x, y) => x.table.localeCompare(y.table) || x.file.localeCompare(y.file) || x.line - y.line);
  const filterColumns: Record<string, string[]> = {};
  for (const [t, s] of readerCols) if (s.size) filterColumns[t] = [...s].sort();
  const model: any = { mode: "codebase", shape: "writers", anchor, members, unresolved: [], resolutionQuality: "FULL",
    tables: readTables, columnGrain: colGrain, filterColumns, ...(members.length ? {} : { noStructure: true, reason: "opaque" }) };
  if (a.format === "llm-context") process.stdout.write(renderWritersSet(model, await snippetReaderOf(a)) + "\n");
  else process.stdout.write(`Writers of ${readTables.map((t) => `"${t}"`).join(", ")} (read by ${anchor.symbol}): ${members.length} write site(s).\n`);
  if (a.emitSeams) { writeFileSync(a.emitSeams, JSON.stringify(stamp(model))); process.stdout.write(`Seams: ${a.emitSeams}\n`); }
  return 0;
}

// Coupling query — THE named front door for the moat: "how is X coupled across the stack?". One call gives the
// anchor's whole DATA BOUNDARY — every shared key (db-table / http-route / event) it reads or writes — and, per key,
// the counterpart sites on the other side of that key. This is the coupling grep and RAG structurally cannot find:
// the two sides share no import, no call, and often no literal token; they meet only through the key.
// Composes the two halves already proven separately: the anchor's own keys (scan_file_keys, span-scoped) and the
// repo-wide floor counterparts (otherSide, uncapped) — grouped BY KEY so the answer reads as a boundary, not a list.
export async function runCouplingSet(a: Args, _scan: typeof import("../codebase/scan/index.js")): Promise<number> {
  if (!a.anchorFile) err("--query coupling requires --center <file>[#symbol]");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { floor_base_index, otherSide, scan_file_keys } = await import("../codebase/coupling/index.js");
  const { symbol_span, complement_unit, accessColumns } = await import("../codebase/coupling/bridge.js");
  const { EngineCtx } = await import("../codebase/engine_ctx.js");
  const { SKIP_DIRS } = await import("../core/resolve/languages/index.js");
  const { renderCoupling } = await import("../codebase/llm_context.js");

  emit(`Resolving the data boundary of ${a.symbol ?? basename(a.anchorFile!)}…`);
  // RUST FIRST (see rustShapeOk) — the whole shape, floor scan included, is in the core.
  const rustA8 = await rustShapeOk(a);
  if (rustA8) {
    try {
      const model: any = { mode: "codebase", ...rustCouplingToModel(rustA8.projectCoupling(a.repo, a.anchorFile!, a.symbol ?? undefined)) };
      if (a.format === "llm-context") process.stdout.write(renderCoupling(model, await snippetReaderOf(a)) + "\n");
      else if (model.noStructure && model.reason === "none")
        process.stdout.write(`Coupling of '${model.anchor.symbol}': it touches no shared key (no db-table/route/event boundary) — nothing to couple.\n`);
      else process.stdout.write(`Coupling of '${model.anchor.symbol}': ${model.keys.length} shared key(s), ${model.total} counterpart site(s).\n`);
      if (a.emitSeams) { writeFileSync(a.emitSeams, JSON.stringify(stamp(model))); process.stdout.write(`Seams: ${a.emitSeams}\n`); }
      return 0;
    } catch { /* fall through to the TS path */ }
  }
  let text: string;
  try { text = readFileSync(join(a.repo, a.anchorFile!), "utf-8"); } catch (e) { err(`cannot read center file: ${(e as Error).message}`); return 1; }

  // 1) the anchor's OWN keys (both roles), scoped to the symbol span when given.
  const span = a.symbol ? await symbol_span(a.repo, a.anchorFile!, a.symbol) : null;
  const inSpan = (line: number) => !span || (line >= span[0] && line <= span[1]);
  const hits = scan_file_keys(a.anchorFile!, text).filter((h) => inSpan(h.line));
  const own = new Map<string, { kind: string; value: string; reads: boolean; writes: boolean }>();
  for (const h of hits) {
    const k = `${h.kind} ${h.value}`;
    const e = own.get(k) ?? { kind: h.kind, value: h.value, reads: false, writes: false };
    if (h.produces) e.writes = true; else e.reads = true;
    own.set(k, e);
  }
  const anchor = { symbol: a.symbol ?? basename(a.anchorFile!), file: a.anchorFile! };
  if (!own.size) {
    const model: any = { mode: "codebase", shape: "coupling", anchor, keys: [], noStructure: true, reason: "none" };
    if (a.format === "llm-context") process.stdout.write(renderCoupling(model, await snippetReaderOf(a)) + "\n");
    else process.stdout.write(`Coupling of '${anchor.symbol}': it touches no shared key (no db-table/route/event boundary) — nothing to couple.\n`);
    // see the same note on the `writers` empty path — an empty answer still owes the caller its model.
    if (a.emitSeams) { writeFileSync(a.emitSeams, JSON.stringify(stamp(model))); process.stdout.write(`Seams: ${a.emitSeams}\n`); }
    return 0;
  }

  // 2) per key, the COUNTERPARTS on the other side (a write's readers, a read's writers) from the repo-wide floor.
  const ctx = new EngineCtx();
  const idx = floor_base_index(a.repo, SKIP_DIRS, ctx);
  const anchorNorm = `${a.anchorFile}`;
  const parseCache = new Map<string, any>();   // one tree-sitter ctx per file across the whole column pass
  const keys: any[] = [];
  for (const e of [...own.values()].sort((x, y) => (x.kind + x.value).localeCompare(y.kind + y.value))) {
    const sides: any[] = [];
    const seen = new Set<string>();
    // the anchor READS this key → its counterparts are the WRITERS (produces:false ⇒ producers); and vice versa.
    for (const [role, produces] of [["writes", false], ["reads", true]] as const) {
      if (role === "writes" && !e.reads) continue;    // only look up writers when the anchor reads it
      if (role === "reads" && !e.writes) continue;    // only look up readers when the anchor writes it
      for (const acc of otherSide(idx, e.kind, e.value, produces)) {
        if (acc.file === anchorNorm) continue;
        const unit = await complement_unit(a.repo, acc.file, acc.line);
        const dk = `${acc.file}#${unit.symbol}#${role}`;
        if (seen.has(dk)) continue;
        seen.add(dk);
        // COLUMN-GRAIN (subsumes the `writers` shape): which columns this counterpart touches, so one `coupling`
        // call answers "who writes the state I read, and on which field" — no second query needed.
        const cols = e.kind === "db-table" ? await accessColumns(a.repo, acc.file, acc.line, parseCache) : { writes: [], reads: [] };
        const columns = role === "writes" ? cols.writes : cols.reads;
        sides.push({ symbol: unit.symbol, file: acc.file, line: to1(acc.line), kind: unit.kind, role, columns });
      }
    }
    sides.sort((x, y) => x.role.localeCompare(y.role) || x.file.localeCompare(y.file) || x.line - y.line);
    keys.push({ kind: e.kind, value: e.value, anchorRole: e.reads && e.writes ? "reads+writes" : e.reads ? "reads" : "writes", sides });
  }
  const total = keys.reduce((n, k) => n + k.sides.length, 0);
  const model: any = { mode: "codebase", shape: "coupling", anchor, keys, total,
    ...(total ? {} : { noStructure: true, reason: "opaque" }) };
  if (a.format === "llm-context") process.stdout.write(renderCoupling(model, await snippetReaderOf(a)) + "\n");
  else process.stdout.write(`Coupling of '${anchor.symbol}': ${keys.length} shared key(s), ${total} counterpart site(s).\n`);
  if (a.emitSeams) { writeFileSync(a.emitSeams, JSON.stringify(stamp(model))); process.stdout.write(`Seams: ${a.emitSeams}\n`); }
  return 0;
}

// Refactor query — the FACTS bundle for "how to refactor X": impact + dependencies + contract in one
// run. A composition; emits a `shape: "refactor"` model. The change PLAN over the facts stays the caller's.
export async function runRefactorFacts(a: Args): Promise<number> {
  if (!(a.symbol && a.anchorFile)) err("--query refactor requires --center <file>#<symbol>");
  const { gatherRefactorFacts } = await import("../codebase/grow/refactor_facts.js");
  const { renderRefactorFacts } = await import("../codebase/llm_context.js");
  emit(`Gathering refactor facts for ${a.symbol}…`);
  // RUST FIRST — `gatherRefactorFacts` embeds the impact facts, which now carry the overlay in the core too.
  const rustA6 = await rustShapeOk(a);
  let rf: any = null;
  if (rustA6) { try { rf = rustRefactorToModel(rustA6.gatherRefactorFacts(a.repo, a.anchorFile!, a.symbol!)); } catch { rf = null; } }
  if (!rf) try { rf = await gatherRefactorFacts(a.repo, a.anchorFile!, a.symbol!, { model: a.model, claudeBin: a.claudeBin }); }
  catch (e) { err(`refactor facts failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...rf };

  if (a.format === "llm-context") process.stdout.write(renderRefactorFacts(model, await snippetReaderOf(a)) + "\n");
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
  // The shared --depth defaults to 1 (a direct-consumer hop); impact is TRANSITIVE, so treat the default
  // as "use the impact default" and only honor an explicit deeper --depth. (depth 1 = find_consumers.)
  // Blast radius = a STRUCTURAL closure (transitive resolved consumers) PLUS the anchor's cross-stack crossings.
  // Traverse structure-only (dataCoupling:false → cached & fast; per-node coupling was ~pure waste and blocked the
  // cache), then attach shared-key readers/writers as ONE anchor overlay (couplingOverlay). Coupling stays ON by
  // default (the cross-stack half a call-graph misses) but is now O(1) coupling passes, not O(closure).
  // RUST FIRST — the cross-stack overlay now lives in the core (`coupling_overlay`), so the gate this shape
  // carried is gone: the addon returns the SAME structural closure AND the same crossings.
  const rustA1 = await rustShapeOk(a);
  let im: any = null;
  if (rustA1) {
    try { im = rustImpactToModel(rustA1.projectImpact(a.repo, a.anchorFile!, a.symbol!, a.depth > 1 ? a.depth : null, null, a.dataCoupling, a.dataCouplingLlm, a.model, a.claudeBin ?? undefined)); }
    catch { im = null; }
  }
  if (!im) try { im = await projectImpact(a.repo, a.anchorFile!, a.symbol!, {
    depth: a.depth > 1 ? a.depth : undefined,
    dataCoupling: false,
    couplingOverlay: a.dataCoupling,
    dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin,
  }); }
  catch (e) { err(`impact analysis failed: ${(e as Error).message}`); }
  const model: any = { mode: "codebase", ...im };

  if (a.format === "llm-context") process.stdout.write(renderImpact(model, await snippetReaderOf(a)) + "\n");
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
  // RUST FIRST (see rustShapeOk). Both sides must be parseable, so the guard is asked for the TARGET too.
  const rustA4 = (a.toFile && await rustShapeOk({ ...a, anchorFile: a.toFile } as Args)) ? await rustShapeOk(a) : null;
  let c: any = null;
  if (rustA4) { try { c = rustCompareToModel(rustA4.projectCompare(a.repo, a.anchorFile!, a.symbol!, a.toFile!, a.toSymbol!)); } catch { c = null; } }
  if (!c) try { c = await projectCompare(a.repo, a.anchorFile!, a.symbol!, a.toFile!, a.toSymbol!, { depth: a.depth, dataCoupling: a.dataCoupling }); }
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
  // RUST FIRST — ungated. The last reported difference (a boundary-crossing coupling edge on
  // profile-view.tsx#onConfirmButton) did NOT reproduce engine-to-engine: called directly, in one process
  // against one store, the two projections are identical member-for-member with the same boundary cut. It was
  // STORE DRIFT inside the comparator — the flywheel writes `.seam` during the first of its two CLI runs, so
  // the second engine reads a store the first one changed. The harness now settles the store before comparing.
  const rustA3 = await rustShapeOk(a);
  let n: any = null;
  // `a.depth` verbatim, NOT `> 1 ? … : null` like impact: this shape passes --depth straight through (default
  // 1) while the addon's own default is 2, so gating it would silently widen the ball on every default query.
  if (rustA3) { try { n = rustNeighborhoodToModel(rustA3.projectNeighborhood(a.repo, a.anchorFile!, a.symbol!, a.depth, null, a.dataCoupling)); } catch { n = null; } }
  if (!n) try { n = await projectNeighborhood(a.repo, a.anchorFile!, a.symbol!, { depth: a.depth, dataCoupling: a.dataCoupling }); }
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
  const rustA2 = await rustShapeOk(a);
  let c: any = null;
  if (rustA2) { try { c = rustContractToModel(rustA2.projectContract(a.repo, a.anchorFile!)); } catch { c = null; } }
  if (!c) try { c = await projectContract(a.repo, a.anchorFile!, { model: a.model, claudeBin: a.claudeBin }); }
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
  // RUST FIRST — the BFS now expands through COUPLING hops too, so a pair joined only through shared state is
  // found there as well and the gate is gone.
  const rustA5 = await rustShapeOk(a);
  let res: any = null;
  if (rustA5) {
    try { res = rustReachToModel(rustA5.findReach(a.repo, a.anchorFile!, a.symbol!, a.toSymbol!, a.toFile ?? null, a.maxHops ?? null, a.dataCoupling !== false)); }
    catch { res = null; }
  }
  // Reachability is purely structural (a path of resolved edges). Coupling is irrelevant to it and only
  // disables the footprint cache — traverse structure-only unless explicitly opted in.
  // couplingHops ON by default (the moat): a pair connected through SHARED STATE (a table one writes and the other
  // reads) is genuinely reachable — a call-only BFS reports a misleading "no path". --no-data-coupling → call-only.
  if (!res) try { res = await findReach(a.repo, a.anchorFile!, a.symbol!, a.toSymbol!, {
    toFile: a.toFile, maxHops: a.maxHops, dataCoupling: a.dataCouplingExplicit ? a.dataCoupling : false,
    couplingHops: a.dataCoupling !== false, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin }); }
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
