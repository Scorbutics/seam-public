// CLI argument parsing for `decompose` — extracted from decompose.ts so it is SIDE-EFFECT-FREE (decompose.ts
// runs main() on import, which a unit test can't tolerate). Pure: argv in, Args out.

export interface Args {
  file?: string; git?: string; submodules?: boolean; fromClassified?: string; repo: string;
  format: string; tokenBudget?: number; classifier?: string; cluster?: string; roles?: string; wiring?: string;
  emitSeams?: string; emitHunks?: string; dumpClassified?: string; facts?: string;
  emitPrompts?: string; injectLlm?: string; model?: string; claudeBin?: string;
  factsEngine?: string; blastRadius: boolean; resolver: string; verbose: boolean;
  // codebase mode:
  scan: boolean; graph?: string; anchorFile?: string; symbol?: string; depth: number;
  emitGraph?: string; intent?: string; fromSeams?: string; promoteSpinePath?: boolean; lineage?: boolean; anchorRecall?: string; anchorSelect?: string; skeleton?: boolean;
  expandGraph?: string; expandFile?: string; expandSymbol?: string; expandLine?: number;
  growFrom?: string;   // --grow-from <file>#<symbol>: DEEPEN — re-anchor the wave grow at a frontier node (+ optional --intent redirect)
  concern?: boolean;   // --concern: CENTER-anchor a plural "how is X managed?" question — detect the shared mechanism + re-grow from it
  center?: string;     // --center <file>[#<symbol>][,<file>[#<symbol>]…]: the universal node address (supersedes --anchor-file/--symbol). file-only = module anchor; comma-separated = multi-center concern star
  down: boolean; crossFrom?: string;
  emitCandidates?: string; attribution?: string; auto: boolean; maxSteps: number; maxNodes?: number;
  llmBridge?: string; dataCoupling: boolean; dataCouplingLlm: boolean; dataCouplingAuto: boolean; dataCouplingExplicit?: boolean; cache: boolean; bidirectional: boolean;
  checkBackend?: boolean; affinity?: boolean; interfaceConsumers?: boolean; listPasses?: boolean;
  excludeDirs?: string[]; includeTests: boolean;   // footprint exclusion: folders to drop; tests dropped unless --include-tests
  trace?: boolean;   // --trace: --verbose + the per-node timing firehose (SEAM_TIMING)
  stream?: boolean;  // --stream: wave-mode NDJSON on stdout (one record per settled wave + a final {done,model})
  query?: string; recall?: string; toSymbol?: string; toFile?: string; maxHops?: number; ask?: string;
  autoRoute?: boolean;   // --auto-route: on an --auto --intent grow, first route the intent (route.ts) — if it's a NON-flow shape (blast-radius/find-usages/…), answer it as that --query shape instead of a noFlow flow grow. The agent entry (grow_intent) sets it.
  reviewImpact?: boolean; triage?: boolean;
  warm?: boolean; warmTop?: number;   // --warm: pre-grow the top-N highest-fan-in hub files to populate the per-node shards (footprint-v1 / coupling-delta-v1), so a later FIRST query on a covered region is served warm. --warm-top N caps the hub set (default 40).
}

// Resolve the three per-pass engines: a per-pass flag wins; else the --classifier preset; else
// the hybrid default (cluster=llm, roles=det, wiring=hybrid) — mirrors src/diff/run.py.
export function resolveEngines(a: Args): { cluster: string; roles: string; wiring: string } {
  return {
    cluster: a.cluster ?? a.classifier ?? "llm",
    roles: a.roles ?? a.classifier ?? "det",
    wiring: a.wiring ?? a.classifier ?? "hybrid",
  };
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { repo: ".", format: "none", blastRadius: false, resolver: "det", verbose: false, scan: false, depth: 1, down: false, auto: false, maxSteps: 4, dataCoupling: true, dataCouplingLlm: false, dataCouplingAuto: true, cache: false, bidirectional: false, includeTests: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    switch (v) {
      case "--file": a.file = next(); break;
      case "--git": a.git = next(); break;
      case "--submodules": a.submodules = true; break;   // also include each git submodule's diff (paths prefixed by the submodule dir)
      case "--from-classified": a.fromClassified = next(); break;
      case "--repo": a.repo = next(); break;
      case "--warm": a.warm = true; break;   // pre-grow hub files to warm the per-node shards (repo-wide precompute)
      case "--warm-top": a.warmTop = parseInt(next(), 10) || undefined; break;
      case "--format": a.format = next(); break;   // codebase grow: agent (DEFAULT — the token-budgeted map) | concern | llm-context (full region) | waves | scenarios | json (raw model to stdout). diff: llm (default) | ascii. `--emit-seams <file>` = the machine model to a file.
      case "--token-budget": a.tokenBudget = parseInt(next(), 10) || undefined; break;   // --format agent: chars/4 budget (default ~4000)
      case "--stream": a.stream = true; break;   // wave-mode NDJSON stream on stdout
      case "--classifier": a.classifier = next(); break;
      case "--cluster": a.cluster = next(); break;
      case "--roles": a.roles = next(); break;
      case "--wiring": a.wiring = next(); break;
      case "--emit-seams": a.emitSeams = next(); break;
      case "--emit-hunks": a.emitHunks = next(); break;
      case "--dump-classified": a.dumpClassified = next(); break;
      case "--facts": a.facts = next(); break;
      case "--emit-prompts": a.emitPrompts = next(); break;
      case "--inject-llm": a.injectLlm = next(); break;
      case "--model": a.model = next(); break;
      case "--claude-bin": a.claudeBin = next(); break;
      case "--facts-engine": a.factsEngine = next(); break;
      case "--resolver": a.resolver = next(); break;
      case "--blast-radius": a.blastRadius = true; break;
      case "--scan": a.scan = true; break;
      case "--graph": a.graph = next(); break;
      case "--anchor-file": a.anchorFile = next(); break;
      case "--symbol": a.symbol = next(); break;
      case "--depth": a.depth = parseInt(next() ?? "1", 10); break;
      case "--emit-graph": a.emitGraph = next(); break;
      case "--intent": a.intent = next(); break;
      case "--from-seams": a.fromSeams = next(); break;   // render an already-emitted seams.json (e.g. --format llm-context)
      case "--promote-spine-path": a.promoteSpinePath = true; break;   // Step 2: promote on-path supporting seams to spine
      case "--lineage": a.lineage = true; break;   // attach per-seam git lineage (last-touching commit) to the footprint
      case "--exclude": a.excludeDirs = (next() ?? "").split(",").map((s) => s.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean); break;   // drop footprint nodes under these folders (name or path prefix)
      case "--include-tests": a.includeTests = true; break;   // keep test files in the footprint (default: dropped)
      case "--anchor-recall": a.anchorRecall = (next() ?? "embed").toLowerCase(); break;   // embed (default) | lexical
      case "--anchor-select": a.anchorSelect = (next() ?? "pick").toLowerCase(); break;   // pick (default; 1 LLM pass, no probe sweep) | probe (probe→judge, kept)
      case "--grow-from": a.growFrom = next(); break;
      case "--concern": a.concern = true; break;
      case "--auto-route": a.autoRoute = true; break;   // route a non-flow intent (blast-radius/find-usages) to its --query shape instead of a flow grow
      case "--center": a.center = next(); break;   // universal node address: file | file#symbol | comma-list; expanded to the anchor below, read as a list by the concern grow
      // --anchor-file / --symbol are the LEGACY node address, superseded by --center (kept for back-compat + internal use).
      case "--expand-graph": a.expandGraph = next(); break;
      case "--expand-file": a.expandFile = next(); break;
      case "--expand-symbol": a.expandSymbol = next(); break;
      case "--expand-line": a.expandLine = parseInt(next() ?? "0", 10); break;
      case "--down": a.down = true; break;
      case "--bidirectional": a.bidirectional = true; break;   // footprint = consumers (forward) + deps (backward)
      case "--cross-from": a.crossFrom = next(); break;
      case "--emit-candidates": a.emitCandidates = next(); break;
      case "--attribution": a.attribution = next(); break;
      case "--auto": a.auto = true; break;
      case "--skeleton": a.skeleton = true; break;   // LLM-consumer output: skip the LLM seam-intent pass (det skeleton: spine + structural labels + blindspots)
      case "--no-skeleton": case "--rank": a.skeleton = false; break;   // force the LLM seam-ranking pass back ON (overrides the llm-context default below)

      case "--max-steps": a.maxSteps = parseInt(next() ?? "4", 10); break;
      case "--max-nodes": a.maxNodes = parseInt(next() ?? "0", 10) || undefined; break;   // grow node budget (auto mode); unset → engine default (80)
      case "--llm-bridge": a.llmBridge = next(); break;
      case "--check-backend": a.checkBackend = true; break;   // probe: exit 0 (+print kind) if a claude/copilot LLM backend resolves, else 1
      case "--list-passes": a.listPasses = true; break;   // print the LLM pass inventory (tag · tier · note) from the registry
      case "--query": a.query = (next() ?? "").toLowerCase(); break;   // non-grow shape: `consumers` = the resolved SET of callers (no spine)
      case "--recall": a.recall = (next() ?? "").toLowerCase(); break;   // consumers SET: `name` = add name-grounded unverified leads (Ruby/C++ floor)
      case "--to-symbol": a.toSymbol = next(); break;   // --query reaches: the TARGET symbol
      case "--to-file": a.toFile = next(); break;       // --query reaches: optionally pin the target's file
      case "--max-hops": a.maxHops = parseInt(next() ?? "40", 10); break;   // --query reaches: BFS budget
      case "--ask": a.ask = next(); break;   // natural-language question → LLM routes to the right shape
      case "--review-impact": a.reviewImpact = true; break;   // diff: annotate seams with codebase impact + cross-stack coupling
      case "--triage": a.triage = true; break;   // review-impact: LLM triage of the `unknown` relevance residual
      case "--affinity": a.affinity = true; break;   // codebase: fold intent-related shared-subject seams (grow-confirmed → resolved; else suggested) into the footprint
      case "--no-interface-consumers": a.interfaceConsumers = false; break;   // disable the default interface-consumer enrichment
      case "--no-data-coupling": a.dataCoupling = false; a.dataCouplingAuto = false; a.dataCouplingExplicit = true; break;
      case "--cache": a.cache = true; break;
      // Force a full REGROW + re-coupling: bypass the graph cache (per-node footprint P3 / coupling-delta P4 /
      // settled-grow answer P5 + the sharded scan) so the wave orchestration and coupling materialisation re-run
      // live. Leaves the LEARNED flywheel matchers (`.seam/key-adapters.json`) intact — they replay
      // deterministically, so this re-runs the work WITHOUT paying the LLM to re-learn. Same as SEAM_GRAPH_CACHE=0.
      case "--no-cache": process.env.SEAM_GRAPH_CACHE = "0"; break;
      // --data-coupling off|floor|llm|auto : off=disabled, floor=deterministic adapters only,
      // llm=floor + the LLM shared-key front-end (always), auto (DEFAULT)=floor + LLM front-end WHEN an LLM
      // backend resolves (learn-once → cached → deterministic warm), else floor. `auto` makes cross-stack
      // coupling on-by-default without paying the LLM when there's no backend or it's disabled.
      case "--data-coupling": { const m = (next() ?? "auto").toLowerCase(); a.dataCoupling = m !== "off"; a.dataCouplingLlm = m === "llm"; a.dataCouplingAuto = m === "auto"; a.dataCouplingExplicit = true; break; }
      case "-v": case "--verbose": a.verbose = true; break;
      case "--trace": a.verbose = true; a.trace = true; break;   // --verbose + the per-node timing firehose
      default:
        if (v.startsWith("-")) { process.stderr.write(`warning: unknown flag ignored: ${v}\n`); }
    }
  }
  // For an LLM-CONSUMER format the consumer ranks/interprets the structure itself, and the WAVE / SCENARIO views
  // read the DETERMINISTIC structure (region.shell + resolved edges), never the LLM tiers/labels — so Seam's own
  // LLM seam-intent (ranking/tiering) + refine passes are redundant latency/cost (and the pass that can stall a
  // whole run on a slow backend). Default them OFF (the det skeleton: spine + structural labels + blindspots).
  // `--rank` / `--no-skeleton` forces them back on.
  if ((a.format === "llm-context" || a.format === "waves" || a.format === "scenarios") && a.skeleton === undefined) a.skeleton = true;
  // --center is the UNIVERSAL node address (supersedes --anchor-file/--symbol). Expand the FIRST center into the
  // internal anchor so EVERY mode — static footprint (§B), structural shapes (§D), single-anchor + concern grow
  // (§C) — accepts --center. A bare `file` is a MODULE anchor (no symbol); `file#symbol` pins one node. An
  // explicit --anchor-file/--symbol still wins if the caller passed one (back-compat). The concern path reads the
  // full list (parseCenters) to grow a multi-center star; here we only need the addressing anchor.
  if (a.center) {
    const cs = parseCenters(a.center);
    // NOTE: existence of each center under --repo is validated in decompose.ts:runCodebase, not here — this module
    // is pure (argv in, Args out) and must not touch the filesystem.
    if (cs.length) { if (!a.anchorFile) a.anchorFile = cs[0].file; if (!a.symbol && cs[0].symbol) a.symbol = cs[0].symbol; }
  }
  return a;
}

// Split a --center spec into addressed nodes. It is a comma-separated list of `file` or `file#symbol` (split on
// the FIRST '#' so a symbol may be qualified); a bare `file` is a module anchor (symbol undefined). Empty entries
// drop out. This is the ONE parser for the flag, shared by the arg expansion above and the concern grow.
export function parseCenters(spec: string): { file: string; symbol?: string }[] {
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const h = s.indexOf("#");
    return h >= 0 ? { file: s.slice(0, h), symbol: s.slice(h + 1) } : { file: s };
  });
}
