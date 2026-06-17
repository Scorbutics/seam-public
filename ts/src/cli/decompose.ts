#!/usr/bin/env bun
// Port of the diff-mode branch of decompose.py + src/diff/run.py — the DETERMINISTIC path
// (--classifier det). LLM/hybrid engines and codebase/HTML modes are not yet ported and error
// clearly rather than silently degrading. Reproduces the flags the VS Code extension uses for
// the `det` engine: --git/--file, --repo, --emit-seams, --format ascii|llm, --emit-hunks,
// --dump-classified/--from-classified, --facts.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import * as diff_source from "../diff/diff_source.js";
import { parse, hunksToJson, hunksFromJson, type Hunk } from "../diff/parser.js";
import * as noise from "../diff/noise_filter.js";
import { assign_spans } from "../diff/classifier_det.js";
import * as engine from "../diff/engine.js";
import { emit_seams_json } from "../diff/seams.js";
import { cacheKey, cacheGet, cachePut } from "../diff/cache.js";
import { render } from "../diff/report_text.js";
import {
  changed_newside, ExternalFactsProvider, MergedFactsProvider, RegexFactsProvider, FACTS_SCHEMA_VERSION, type FactsProvider,
} from "../diff/facts.js";
import { HostBus, InteractiveHostBus, set_host_bus, get_host_bus, reset_usage, get_usage } from "../core/llm.js";
import { stampSeamModel } from "../core/contract.js";
import { emit } from "../core/progress.js";
import { readFileSync } from "node:fs";

interface Args {
  file?: string; git?: string; fromClassified?: string; repo: string;
  format: string; classifier?: string; cluster?: string; roles?: string; wiring?: string;
  emitSeams?: string; emitHunks?: string; dumpClassified?: string; facts?: string;
  emitPrompts?: string; injectLlm?: string; model?: string; claudeBin?: string;
  factsEngine?: string; blastRadius: boolean; resolver: string; verbose: boolean;
  // codebase mode:
  scan: boolean; graph?: string; anchorFile?: string; symbol?: string; depth: number;
  emitGraph?: string; intent?: string; fromSeams?: string; promoteSpinePath?: boolean; lineage?: boolean; anchorRecall?: string;
  expandGraph?: string; expandFile?: string; expandSymbol?: string; expandLine?: number;
  down: boolean; crossFrom?: string;
  emitCandidates?: string; attribution?: string; auto: boolean; maxSteps: number;
  llmBridge?: string; dataCoupling: boolean; dataCouplingLlm: boolean; cache: boolean; bidirectional: boolean; grow: string;
}

// Resolve the three per-pass engines: a per-pass flag wins; else the --classifier preset; else
// the hybrid default (cluster=llm, roles=det, wiring=hybrid) — mirrors src/diff/run.py.
function resolveEngines(a: Args): { cluster: string; roles: string; wiring: string } {
  return {
    cluster: a.cluster ?? a.classifier ?? "llm",
    roles: a.roles ?? a.classifier ?? "det",
    wiring: a.wiring ?? a.classifier ?? "hybrid",
  };
}

function parseArgs(argv: string[]): Args {
  const a: Args = { repo: ".", format: "none", blastRadius: false, resolver: "det", verbose: false, scan: false, depth: 1, down: false, auto: false, maxSteps: 4, dataCoupling: true, dataCouplingLlm: false, cache: false, bidirectional: false, grow: "det" };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    switch (v) {
      case "--file": a.file = next(); break;
      case "--git": a.git = next(); break;
      case "--from-classified": a.fromClassified = next(); break;
      case "--repo": a.repo = next(); break;
      case "--format": a.format = next(); break;
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
      case "--anchor-recall": a.anchorRecall = (next() ?? "embed").toLowerCase(); break;   // embed (default) | lexical
      case "--expand-graph": a.expandGraph = next(); break;
      case "--expand-file": a.expandFile = next(); break;
      case "--expand-symbol": a.expandSymbol = next(); break;
      case "--expand-line": a.expandLine = parseInt(next() ?? "0", 10); break;
      case "--down": a.down = true; break;
      case "--bidirectional": a.bidirectional = true; break;   // footprint = consumers (forward) + deps (backward)
      case "--grow": a.grow = (next() ?? "det").toLowerCase(); break;   // auto-grow strategy: det (deterministic, default) | llm
      case "--cross-from": a.crossFrom = next(); break;
      case "--emit-candidates": a.emitCandidates = next(); break;
      case "--attribution": a.attribution = next(); break;
      case "--auto": a.auto = true; break;
      case "--max-steps": a.maxSteps = parseInt(next() ?? "4", 10); break;
      case "--llm-bridge": a.llmBridge = next(); break;
      case "--no-data-coupling": a.dataCoupling = false; break;
      case "--cache": a.cache = true; break;
      // --data-coupling off|floor|llm : off=disabled, floor=deterministic adapters (default),
      // llm=floor + the LLM shared-key front-end (cross-framework key proposals).
      case "--data-coupling": { const m = (next() ?? "floor").toLowerCase(); a.dataCoupling = m !== "off"; a.dataCouplingLlm = m === "llm"; break; }
      case "-v": case "--verbose": a.verbose = true; break;
      case "--context-window": case "-o": case "--out":
        next(); break; // accepted-and-ignored on the ported paths
      case "--open": case "--debug": break; // boolean, ignored on the ported paths
      default:
        if (v.startsWith("-")) { process.stderr.write(`warning: unknown flag ignored: ${v}\n`); }
    }
  }
  return a;
}

function err(msg: string): never { process.stderr.write(`error: ${msg}\n`); process.exit(2); }

// Codebase mode — decompose an anchor footprint (or a ResolvedGraph) into seams. Claimed by
// --scan / --graph (mirrors src/codebase/run.py CodebaseMode.claims).
async function runCodebase(a: Args): Promise<number> {
  reset_usage();
  if (a.resolver !== "det") {
    const { make_resolver } = await import("../core/resolve/resolver.js");
    const { set_resolver } = await import("../core/resolve/consumers.js");
    try { set_resolver(await make_resolver(a.resolver)); } catch (e) { err((e as Error).message); }
  }
  const scan = await import("../codebase/import_scan.js");
  const { from_resolved_graph } = await import("../core/graph_ir.js");
  const { decompose } = await import("../codebase/codebase.js");

  const useLlm0 = a.classifier === "llm" || a.classifier === "hybrid";
  let data: any;
  if (a.expandGraph) {
    if (!(a.expandFile && a.expandSymbol)) err("--expand-graph requires --expand-file and --expand-symbol");
    const { merge_resolved } = await import("../codebase/expand.js");
    try {
      const base = JSON.parse(readFileSync(a.expandGraph, "utf-8"));
      const add = a.down
        ? await scan.build_dependency_graph(a.repo, a.expandFile!, a.expandSymbol!, { anchorLine: a.expandLine ?? null, useLlm: useLlm0, model: a.model, claudeBin: a.claudeBin, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm })
        : await scan.build_consumers_graph(a.repo, a.expandFile!, a.expandSymbol!, { depth: a.depth, anchorLine: a.expandLine ?? null, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin });
      data = merge_resolved(base, add, add.anchor?.id);
      if (a.crossFrom) (data.blindspots ??= []).push({ node: add.anchor?.symbol ?? "", mechanism: "suggested-crossing", evidence: a.crossFrom, candidates: [] });
    } catch (e) { err(`expand failed: ${(e as Error).message}`); }
  } else if (a.scan) {
    // Auto-anchor: --auto with --intent but NO --symbol → SELECT the anchor instead of the user picking
    // one (a bad pick linked to nothing hides the real result).
    if (a.auto && a.intent && !a.symbol) {
      // #1 ENUMERATE the HTTP entry points (structure): a route handler whose convention name (`GET`/
      // `POST`/slug) or anonymous edge fn the lexical net can't see. The LLM names the route the intent
      // points at, if any. This is a RECALL source, NOT a preemptive override: the picked route enters
      // the SAME probe→judge funnel as a SEED candidate, so a tangential route ("/bug-reports/screenshot"
      // for "how is a bug created") can't hijack a better service anchor — it wins only if its grown
      // footprint best answers the intent (decide-LAST, the pattern that survived).
      const { available } = await import("../core/llm.js");
      const seeds: { name: string; file: string; kind: string }[] = [];
      if (available(a.claudeBin)) {
        const ep = await import("../codebase/entrypoint_select.js");
        const eps = ep.enumerate_entrypoints(a.repo);
        const pick = ep.select_entrypoint_llm(a.intent, eps, { model: a.model, claudeBin: a.claudeBin });
        if (pick) {
          const [file, symbol] = await ep.entrypoint_anchor(a.repo, pick);
          seeds.push({ name: symbol, file, kind: "route" });
          process.stdout.write(`[entry-candidate] ${pick.path} → ${symbol} (${file})\n`);
        }
      }
      // Structural probe floor drops the isolated candidates; an LLM judges which connected footprint
      // (lexical/embed symbols + any entry-point seed) is the intent's entry point. Embed recall is the
      // DEFAULT (graduated the gate: 83% vs lexical 50%, no per-case regression, recovers the fuzzy
      // name-mismatch anchors the lexical net misses); `--anchor-recall lexical` opts out. Where
      // transformers.js isn't available (e.g. the bundled .vsix) embed_anchor_candidates returns [] and
      // it degrades to lexical, so defaulting on is safe.
      const { select_anchor } = await import("../codebase/anchor_select.js");
      const sel = await select_anchor(a.repo, a.intent, { dataCoupling: a.dataCoupling, model: a.model, claudeBin: a.claudeBin, anchorRecall: a.anchorRecall === "lexical" ? "lexical" : "embed", seeds });
      if (!sel.chosen) err(`auto-anchor: no connected anchor found for "${a.intent}"`);
      a.anchorFile = sel.chosen!.file; a.symbol = sel.chosen!.name;
      const via = sel.chosen!.terms?.includes("~entry") ? "entry" : sel.chosenBy;
      process.stdout.write(`[auto-anchor:${via}] ${sel.chosen!.name} (${sel.chosen!.file})\n`);
      // honest signal: the chosen anchor is a computation/strategy unit with no traceable flow — the
      // grow will be a 1-seam stub, not a spine. Surface it rather than letting the user read it as a miss.
      if (sel.noFlow) process.stdout.write(`[no-flow] "${a.intent}" resolves to dispatch/computation code with no traceable spine; expect touchpoints, not an ordered path.\n`);
    }
    if (!a.anchorFile) err("--scan requires --anchor-file");
    // CLASS anchor, phase 1: emit the LSP-verification candidates and exit (the extension verifies
    // them, then re-invokes with --attribution).
    if (a.emitCandidates) {
      if (!a.symbol) err("--emit-candidates needs --symbol (a class anchor)");
      const cands = await scan.class_call_candidates(a.repo, a.anchorFile!, a.symbol!);
      writeFileSync(a.emitCandidates, JSON.stringify(cands));
      process.stdout.write(`Candidates: ${a.emitCandidates}  (${cands.length} call-site(s))\n`);
      return 0;
    }
    if (a.auto) {
      // P5: LLM-directional auto-orchestration — grow toward the intent, then decompose.
      if (!(a.symbol && a.intent)) err("--auto requires --symbol and --intent");
      const orch = await import("../codebase/orchestrate.js");
      let hist: any[];
      // `--grow det` (default) follows the resolved crossings to the terminals deterministically — no LLM
      // move-picker (the intent is still used downstream, by the tier pass). `--grow llm` = the old
      // LLM-orchestrated grow.
      try {
        [data, hist] = a.grow === "llm"
          ? await orch.auto_orchestrate(a.repo, a.anchorFile!, a.symbol!, a.intent!, { maxSteps: a.maxSteps, model: a.model, claudeBin: a.claudeBin, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm })
          : await orch.grow_to_terminals(a.repo, a.anchorFile!, a.symbol!, { bidirectional: true, flagTruncation: true, model: a.model, claudeBin: a.claudeBin, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm });
      }
      catch (e) { err(`auto-grow failed: ${(e as Error).message}`); }
      process.stdout.write(`[auto:${a.grow}] ${hist!.length} move(s): ` + (hist!.map((h) => `${h.node}(+${h.added}${h.dir ? " " + h.dir : ""})`).join(", ") || "none") + "\n");
      const g2 = from_resolved_graph(data);
      const model2: any = await decompose(g2, { repo: a.repo, useLlm: true, intent: a.intent, model: a.model, claudeBin: a.claudeBin, promoteSpinePath: a.promoteSpinePath, lineage: a.lineage });
      model2.autoGrown = true;   // the GROWN footprint is the answer — render it ALL, don't isolate one seam
      if (a.emitGraph) writeFileSync(a.emitGraph, JSON.stringify(data));
      if (a.emitSeams) {
        const usage = get_usage().as_dict();
        if (usage) model2.usage = usage;
        writeFileSync(a.emitSeams, JSON.stringify(stampSeamModel(model2)));
        process.stdout.write(`Seams: ${a.emitSeams}\n`);
      }
      return 0;
    }
    let verified: any = null;
    if (a.attribution) {
      try { verified = JSON.parse(readFileSync(a.attribution, "utf-8")); }
      catch (e) { err(`could not load attribution: ${(e as Error).message}`); }
    }
    emit(a.symbol ? `Scanning consumers of ${a.symbol}…` : `Scanning module ${basename(a.anchorFile!)}…`);
    try {
      // --symbol → single-symbol anchor; CONSUMERS = importers + (class/interface) call-sites in one.
      // Omit --symbol → MODULE mode (all exports as members, member co-occurrence).
      data = a.symbol
        ? a.bidirectional
          ? await scan.build_bidirectional_graph(a.repo, a.anchorFile!, a.symbol, { dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin })
          : await scan.build_consumers_graph(a.repo, a.anchorFile!, a.symbol, { depth: a.depth, verified, dataCoupling: a.dataCoupling, dataCouplingLlm: a.dataCouplingLlm, model: a.model, claudeBin: a.claudeBin })
        : await scan.build_module_graph(a.repo, a.anchorFile!);
    } catch (e) { err(`import scan failed: ${(e as Error).message}`); }
  } else {
    try { data = JSON.parse(readFileSync(a.graph!, "utf-8")); }
    catch (e) { err(`could not load resolved graph: ${(e as Error).message}`); }
  }
  const g = from_resolved_graph(data);
  if (!g.nodes.size) err("resolved graph has no nodes");
  const useLlm = a.classifier === "llm" || a.classifier === "hybrid";
  // Host-served LLM (skill / verification): same emit-prompts/inject-llm contract as diff mode.
  if (a.emitPrompts) set_host_bus(new HostBus());
  else if (a.injectLlm) set_host_bus(new HostBus(JSON.parse(readFileSync(a.injectLlm, "utf-8")).answers ?? {}));
  let model: any, recorded: HostBus["recorded"] | undefined;
  try { model = await decompose(g, { repo: a.repo, useLlm, intent: a.intent, model: a.model, claudeBin: a.claudeBin, promoteSpinePath: a.promoteSpinePath, lineage: a.lineage }); }
  finally { if (a.emitPrompts || a.injectLlm) { recorded = get_host_bus()?.recorded; set_host_bus(null); } }
  if (a.emitPrompts) {
    const passes = [...(recorded ?? new Map()).entries()].map(([tag, rec]) => ({ tag, ...rec }));
    writeFileSync(a.emitPrompts, JSON.stringify({ version: 1, source: { scan: a.scan, graph: a.graph ?? null, repo: a.repo }, passes }, null, 2));
    process.stdout.write(`Prompts: ${a.emitPrompts} (${passes.length} pass${passes.length !== 1 ? "es" : ""}: ${passes.map((p) => p.tag).join(", ") || "none"})\n`);
    return 0;
  }

  const counts = new Map<string, number>();
  for (const n of g.nodes.values()) counts.set(n.role, (counts.get(n.role) ?? 0) + 1);
  const summary = ["core", "link", "environment", "test"].map((r) => `${r}=${counts.get(r) ?? 0}`).join("  ");
  const usageLine = get_usage().summary();
  process.stdout.write(`Decomposed anchor '${g.anchor}' (${g.nodes.size} symbols, resolution=${g.resolution_quality || "?"}):  ${summary}`
    + (usageLine ? `   [${usageLine}]` : "") + "\n");
  if (g.unresolved.length) {
    process.stdout.write(`  ${g.unresolved.length} unresolved (UNKNOWN, not 'no link'); `
      + `${g.blindspots.length} blind spot(s)\n`);
  }

  if (a.expandGraph) model.autoGrown = true;        // a grown footprint — show the whole thing
  if (a.emitGraph) writeFileSync(a.emitGraph, JSON.stringify(data));
  if (a.emitSeams) {
    const usage = get_usage().as_dict();
    if (usage) model.usage = usage;
    writeFileSync(a.emitSeams, JSON.stringify(stampSeamModel(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  // --llm-bridge installs an INTERACTIVE host bus (process-wide) so every LLM pass — including the
  // in-the-loop auto-orchestration moves — is served on demand by a host (the MCP server's sampling).
  // Covers BOTH modes, so it must be set before dispatch and before any mode's own host-bus handling.
  if (a.llmBridge) set_host_bus(new InteractiveHostBus(a.llmBridge));
  // --from-seams: render an already-emitted seams.json — a pure projection (no engine, no LLM). The
  // `llm-context` format is a token-economical, no-collapse, confidence-ranked view for a downstream agent.
  if (a.fromSeams) {
    const m = JSON.parse(readFileSync(a.fromSeams, "utf-8"));
    if (a.format === "llm-context") { const { renderLlmContext } = await import("../codebase/llm_context.js"); process.stdout.write(renderLlmContext(m) + "\n"); return 0; }
    err("--from-seams currently supports --format llm-context");
  }
  if (a.scan || a.graph || a.expandGraph) return runCodebase(a);   // codebase mode claims --scan / --graph / --expand-graph
  reset_usage();
  let hunks: Hunk[];

  if (a.fromClassified) {
    hunks = hunksFromJson(readFileSync(a.fromClassified, "utf-8"));
    if (!hunks.length) err("no hunks in classified file");
    if (!hunks.some((h) => h.placements.length)) assign_spans(hunks.filter((h) => h.role !== "noise"), a.repo);
  } else {
    const eng = resolveEngines(a);
    // Install the resolution strategy (det = the built-in floor, no override). Drives --blast-radius
    // and --facts-engine resolve against the real repo. Process-wide; set once.
    if (a.resolver !== "det") {
      const { make_resolver } = await import("../core/resolve/resolver.js");
      const { set_resolver } = await import("../core/resolve/consumers.js");
      try { set_resolver(await make_resolver(a.resolver)); } catch (e) { err((e as Error).message); }
    }
    let diffText: string;
    try { diffText = diff_source.get_diff({ file: a.file, git: a.git, repo: a.repo }); }
    catch (e) { err((e as Error).message); }
    hunks = parse(diffText!);
    if (!hunks.length) err("no hunks found in diff");

    if (a.emitHunks) {
      const skel = hunks.map((h) => {
        const cn = changed_newside(h);
        const [start, end] = cn ? [cn[0], Math.max(cn[0], cn[1] - 1)] : [0, 0];
        return { id: h.id, file: h.file_path, start, end };
      });
      writeFileSync(a.emitHunks, JSON.stringify({ version: FACTS_SCHEMA_VERSION, hunks: skel }));
      process.stdout.write(`Hunks: ${a.emitHunks}\n`);
      return 0;
    }

    noise.classify(hunks);

    // Classify cache (opt-in via --cache): the deterministic engine is ~0.3s; the LLM passes are the
    // cost, and an unchanged diff re-classifies to the same thing. Key the post-classify hunks by the
    // diff + per-pass config + model + repo and skip the LLM on a hit. OFF by default (the eval
    // harness needs FRESH samples per run); the extension opts in for instant re-review of a stable
    // PR. Bypassed for the explicit LLM-control modes (emit-prompts / inject-llm).
    const useCache = a.cache && !a.emitPrompts && !a.injectLlm;
    const ckey = useCache
      ? cacheKey({ diff: diffText!, cluster: eng.cluster, roles: eng.roles, wiring: eng.wiring,
          model: a.model, repo: a.repo, factsEngine: a.factsEngine, resolver: a.resolver })
      : "";
    const cached = useCache ? cacheGet(ckey) : null;
    const loadedHunks = cached ? hunksFromJson(cached) : [];
    if (loadedHunks.length) {
      hunks = loadedHunks;
      emit("Loaded classified decomposition from cache (LLM skipped)");
    } else {
      let factsProvider: FactsProvider | undefined;
      if (a.facts) {
        const payload = JSON.parse(readFileSync(a.facts, "utf-8"));
        if (payload.partial) {
          // The editor's DocumentSymbol facts (defines/enclosing) overlaid on a base producer.
          factsProvider = new MergedFactsProvider(new RegexFactsProvider(), payload);
        } else factsProvider = new ExternalFactsProvider(payload);
      } else if (a.factsEngine === "treesitter") {
        // Headless full-file AST facts (web-tree-sitter) — an async pre-pass producing a payload the
        // sync pipeline consumes; per-hunk regex fallback for anything tree-sitter can't handle.
        const ts = await import("../diff/facts_treesitter.js");
        if (!ts.available()) process.stderr.write("warning: tree-sitter grammars not found; using regex facts\n");
        else {
          const work = hunks.filter((h) => h.role !== "noise");
          const payload = await ts.computeTreeSitterFacts(work, new ts.RepoFileSource(a.repo));
          factsProvider = new ExternalFactsProvider(payload);
        }
      } else if (a.factsEngine === "resolve") {
        // base facts (regex) PLUS codebase-resolved out-of-diff refs grounded to in-diff cores.
        const { ResolvedFactsProvider } = await import("../diff/facts_resolve.js");
        factsProvider = new ResolvedFactsProvider(new RegexFactsProvider(), a.repo);
      }

      // Host-served LLM (Claude Code skill / verification): --emit-prompts records each pass's
      // prompt and applies nothing; --inject-llm replays canned replies. Same contract as Python.
      if (a.emitPrompts) set_host_bus(new HostBus());
      else if (a.injectLlm) set_host_bus(new HostBus(JSON.parse(readFileSync(a.injectLlm, "utf-8")).answers ?? {}));
      let recorded: HostBus["recorded"] | undefined;
      try {
        await engine.classify(hunks, { cluster: eng.cluster, roles: eng.roles, wiring: eng.wiring,
          facts_provider: factsProvider, repo: a.repo, model: a.model, claudeBin: a.claudeBin });
      } catch (e) { err((e as Error).message); }
      finally {
        if (a.emitPrompts || a.injectLlm) { recorded = get_host_bus()?.recorded; set_host_bus(null); }
      }
      if (a.emitPrompts) {
        const passes = [...(recorded ?? new Map()).entries()].map(([tag, rec]) => ({ tag, ...rec }));
        writeFileSync(a.emitPrompts, JSON.stringify({ version: 1,
          source: { git: a.git ?? null, file: a.file ?? null, repo: a.repo }, passes }, null, 2));
        process.stdout.write(`Prompts: ${a.emitPrompts} (${passes.length} pass${passes.length !== 1 ? "es" : ""}: ${passes.map((p) => p.tag).join(", ") || "none"})\n`);
        return 0;
      }
      if (useCache) cachePut(ckey, hunksToJson(hunks));   // store the fresh classification for next time
    }

    if (a.dumpClassified) {
      writeFileSync(a.dumpClassified, hunksToJson(hunks));
      // Terminal when no render was asked for (format is the no-render default) — lets the eval
      // harness drive the engine as a black box without a render mode.
      if (!a.emitSeams && a.format !== "ascii" && a.format !== "llm") {
        process.stdout.write(`Classified${loadedHunks.length ? " (cached)" : ""}: ${a.dumpClassified}\n`);
        return 0;
      }
    }
  }

  const counts = new Map<string, number>();
  for (const h of hunks) counts.set(h.role!, (counts.get(h.role!) ?? 0) + 1);
  const summary = ["core", "link", "environment", "test", "noise"].map((r) => `${r}=${counts.get(r) ?? 0}`).join("  ");
  const textFmt = a.format === "llm" || a.format === "ascii";
  (textFmt ? process.stderr : process.stdout).write(`Decomposed ${hunks.length} hunks:  ${summary}\n`);

  if (textFmt) { process.stdout.write(await render(hunks, { style: a.format, repo: a.repo, blast_radius: a.blastRadius })); return 0; }

  if (a.emitSeams) {
    const model: any = await emit_seams_json(hunks, a.repo, a.blastRadius);
    const usage = get_usage().as_dict();
    if (usage) model.usage = usage;              // tokens/cost for the extension's info message
    writeFileSync(a.emitSeams, JSON.stringify(stampSeamModel(model)));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
    return 0;
  }

  // The HTML report was intentionally removed (the VS Code extension renders natively). An explicit
  // --format html is a clear error; the bare invocation (no format/emit/dump) falls back to the `llm`
  // text report so the CLI always produces something useful.
  if (a.format === "html") err("the HTML report has been removed; use --format ascii|llm or --emit-seams.");
  process.stdout.write(await render(hunks, { style: "llm", repo: a.repo, blast_radius: a.blastRadius }));
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
