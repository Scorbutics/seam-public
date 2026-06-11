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
import { readFileSync } from "node:fs";

interface Args {
  file?: string; git?: string; fromClassified?: string; repo: string;
  format: string; classifier?: string; cluster?: string; roles?: string; wiring?: string;
  emitSeams?: string; emitHunks?: string; dumpClassified?: string; facts?: string;
  emitPrompts?: string; injectLlm?: string; model?: string; claudeBin?: string;
  verbose: boolean;
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
  const a: Args = { repo: ".", format: "html", verbose: false };
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
      case "-v": case "--verbose": a.verbose = true; break;
      case "--context-window": case "--resolver":
      case "--facts-engine": case "-o": case "--out":
        next(); break; // accepted-and-ignored on the ported paths
      case "--blast-radius": case "--open": case "--debug": break; // boolean, ignored on det path
      default:
        if (v.startsWith("-")) { process.stderr.write(`warning: unknown flag ignored: ${v}\n`); }
    }
  }
  return a;
}

function err(msg: string): never { process.stderr.write(`error: ${msg}\n`); process.exit(2); }

function main(argv: string[]): number {
  const a = parseArgs(argv);
  reset_usage();
  let hunks: Hunk[];

  if (a.fromClassified) {
    hunks = hunksFromJson(readFileSync(a.fromClassified, "utf-8"));
    if (!hunks.length) err("no hunks in classified file");
    if (!hunks.some((h) => h.placements.length)) assign_spans(hunks.filter((h) => h.role !== "noise"), a.repo);
  } else {
    const eng = resolveEngines(a);
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
        // Base = tree-sitter if a precomputed --facts-engine ran (Phase 5b); else regex.
        factsProvider = new MergedFactsProvider(new RegexFactsProvider(), payload);
      } else factsProvider = new ExternalFactsProvider(payload);
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
    if (a.dumpClassified) writeFileSync(a.dumpClassified, hunksToJson(hunks));
  }

  const counts = new Map<string, number>();
  for (const h of hunks) counts.set(h.role!, (counts.get(h.role!) ?? 0) + 1);
  const summary = ["core", "link", "environment", "test", "noise"].map((r) => `${r}=${counts.get(r) ?? 0}`).join("  ");
  const textFmt = a.format === "llm" || a.format === "ascii";
  (textFmt ? process.stderr : process.stdout).write(`Decomposed ${hunks.length} hunks:  ${summary}\n`);

  if (textFmt) { process.stdout.write(render(hunks, { style: a.format, repo: a.repo })); return 0; }

  if (a.emitSeams) {
    const model: any = emit_seams_json(hunks, a.repo);
    const usage = get_usage().as_dict();
    if (usage) model.usage = usage;              // tokens/cost for the extension's info message
    writeFileSync(a.emitSeams, JSON.stringify(model));
    process.stdout.write(`Seams: ${a.emitSeams}\n`);
    return 0;
  }

  err("HTML report output is not yet ported; use --format ascii|llm or --emit-seams (see ts/PORT-STATUS.md).");
}

process.exit(main(process.argv.slice(2)));
