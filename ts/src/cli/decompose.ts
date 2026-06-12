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
import { render } from "../diff/report_text.js";
import {
  changed_newside, ExternalFactsProvider, MergedFactsProvider, RegexFactsProvider, FACTS_SCHEMA_VERSION, type FactsProvider,
} from "../diff/facts.js";
import { HostBus, set_host_bus, get_host_bus, reset_usage, get_usage } from "../core/llm.js";
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
  emitGraph?: string; intent?: string;
  expandGraph?: string; expandFile?: string; expandSymbol?: string; expandLine?: number;
  down: boolean; crossFrom?: string;
  emitCandidates?: string; attribution?: string; auto: boolean; maxSteps: number;
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
  const a: Args = { repo: ".", format: "html", blastRadius: false, resolver: "det", verbose: false, scan: false, depth: 1, down: false, auto: false, maxSteps: 4 };
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
      case "--expand-graph": a.expandGraph = next(); break;
      case "--expand-file": a.expandFile = next(); break;
      case "--expand-symbol": a.expandSymbol = next(); break;
      case "--expand-line": a.expandLine = parseInt(next() ?? "0", 10); break;
      case "--down": a.down = true; break;
      case "--cross-from": a.crossFrom = next(); break;
      case "--emit-candidates": a.emitCandidates = next(); break;
      case "--attribution": a.attribution = next(); break;
      case "--auto": a.auto = true; break;
      case "--max-steps": a.maxSteps = parseInt(next() ?? "4", 10); break;
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
        ? await scan.build_dependency_graph(a.repo, a.expandFile!, a.expandSymbol!, { anchorLine: a.expandLine ?? null, useLlm: useLlm0, model: a.model, claudeBin: a.claudeBin })
        : await scan.build_consumers_graph(a.repo, a.expandFile!, a.expandSymbol!, { depth: a.depth, anchorLine: a.expandLine ?? null });
      data = merge_resolved(base, add, add.anchor?.id);
      if (a.crossFrom) (data.blindspots ??= []).push({ node: add.anchor?.symbol ?? "", mechanism: "suggested-crossing", evidence: a.crossFrom, candidates: [] });
    } catch (e) { err(`expand failed: ${(e as Error).message}`); }
  } else if (a.scan) {
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
      const { auto_orchestrate } = await import("../codebase/orchestrate.js");
      let hist: any[];
      try { [data, hist] = await auto_orchestrate(a.repo, a.anchorFile!, a.symbol!, a.intent!, { maxSteps: a.maxSteps, model: a.model, claudeBin: a.claudeBin }); }
      catch (e) { err(`auto-orchestration failed: ${(e as Error).message}`); }
      process.stdout.write(`[auto] ${hist!.length} move(s): ` + (hist!.map((h) => `${h.direction}:${h.node}(+${h.added})`).join(", ") || "none") + "\n");
      const g2 = from_resolved_graph(data);
      const model2: any = await decompose(g2, { repo: a.repo, useLlm: true, intent: a.intent, model: a.model, claudeBin: a.claudeBin });
      model2.autoGrown = true;   // the GROWN footprint is the answer — render it ALL, don't isolate one seam
      if (a.emitGraph) writeFileSync(a.emitGraph, JSON.stringify(data));
      if (a.emitSeams) {
        const usage = get_usage().as_dict();
        if (usage) model2.usage = usage;
        writeFileSync(a.emitSeams, JSON.stringify(model2));
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
        ? await scan.build_consumers_graph(a.repo, a.anchorFile!, a.symbol, { depth: a.depth, verified })
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
  try { model = await decompose(g, { repo: a.repo, useLlm, intent: a.intent, model: a.model, claudeBin: a.claudeBin }); }
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
    writeFileSync(a.emitSeams, JSON.stringify(model));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
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
      engine.classify(hunks, { cluster: eng.cluster, roles: eng.roles, wiring: eng.wiring,
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
    if (a.dumpClassified) {
      writeFileSync(a.dumpClassified, hunksToJson(hunks));
      // Terminal when no render was asked for (format defaults to the un-ported html) — lets the
      // eval harness drive the TS engine as a black box without a render mode.
      if (!a.emitSeams && a.format !== "ascii" && a.format !== "llm") {
        process.stdout.write(`Classified: ${a.dumpClassified}\n`);
        return 0;
      }
    }
  }

  const counts = new Map<string, number>();
  for (const h of hunks) counts.set(h.role!, (counts.get(h.role!) ?? 0) + 1);
  const summary = ["core", "link", "environment", "test", "noise"].map((r) => `${r}=${counts.get(r) ?? 0}`).join("  ");
  const textFmt = a.format === "llm" || a.format === "ascii";
  (textFmt ? process.stderr : process.stdout).write(`Decomposed ${hunks.length} hunks:  ${summary}\n`);

  if (textFmt) { process.stdout.write(render(hunks, { style: a.format, repo: a.repo, blast_radius: a.blastRadius })); return 0; }

  if (a.emitSeams) {
    const model: any = emit_seams_json(hunks, a.repo, a.blastRadius);
    const usage = get_usage().as_dict();
    if (usage) model.usage = usage;              // tokens/cost for the extension's info message
    writeFileSync(a.emitSeams, JSON.stringify(model));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
    return 0;
  }

  err("HTML report output is not yet ported; use --format ascii|llm or --emit-seams (see ts/PORT-STATUS.md).");
}

main(process.argv.slice(2)).then((code) => process.exit(code));
