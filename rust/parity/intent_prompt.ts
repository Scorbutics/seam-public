// DIFFERENTIAL: Rust `seam_decompose::intent::build_intent_prompt` vs the TypeScript oracle.
//
// The seam-intent prompt is the deterministic FACTS the model is asked to confirm rather than derive — hop
// distance, endpoint-ness, the subject tables a seam touches, which it WRITES, its grow direction. If those
// drift, the model is handed wrong facts and answers confidently from them: a failure with no visible
// symptom, which is exactly why this is worth a byte-for-byte comparison.
//
// THE PROMPT IS CAPTURED THROUGH THE HOST BUS, not from an extracted helper. The TypeScript assembles it
// inline inside `label_focus_relevance_llm`, and refactoring it out first would mean comparing against code
// written for this harness rather than against the code that runs. A capturing bus gets the real string off
// the real path.
//
//   bun rust/parity/intent_prompt.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { from_resolved_graph } from "../../ts/src/core/graph_ir.js";
import { assign_roles } from "../../ts/src/codebase/seams/roles.js";
import { assign_clusters, assign_intent_seams, type Seam } from "../../ts/src/codebase/seams/clusters.js";
import { label_focus_relevance_llm } from "../../ts/src/codebase/seams/intent_llm.js";
import { HostBus, set_host_bus } from "../../ts/src/core/llm.js";
import { loadAddon, toResolvedGraph } from "../../ts/src/codebase/rust_core.js";
import { toWire } from "../../ts/src/codebase/seams/wire.js";

const addon = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");
const fixtures = join(REPO, "ts", "test", "fixtures");

const sw = (seams: Seam[]) => JSON.stringify(seams.map((s) => ({
  id: s.id, label: s.label, link_only: s.linkOnly, node_ids: s.node_ids, proposed_by: s.proposedBy,
  ...(s.suggested ? { suggested: true } : {}),
})));

// A bus that CAPTURES the prompt and answers with an empty verdict list, so the pass runs to completion
// without a model and without mutating anything we care about.
let captured: string | null = null;
class CaptureBus extends HostBus {
  serve(tag: string, prompt: string, _model: string, _thinking: number | null): string {
    if (tag === "seam-intent") captured = prompt;
    return "[]";
  }
}

// ---- corpus ---------------------------------------------------------------------------------------------
const corpus: Array<{ name: string; data: any }> = [];
for (const f of readdirSync(fixtures).filter((f) => f.endsWith("-graph.json"))) {
  corpus.push({ name: f, data: JSON.parse(readFileSync(join(fixtures, f), "utf-8")) });
}
const build = (fn: string, ...args: any[]) => { try { return (addon as any)[fn](...args); } catch { return null; } };
const targets: Array<[string, string, string]> = [];
for (const d of readdirSync(fixtures).filter((d) => d.endsWith("-repo"))) {
  const repo = join(fixtures, d);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name === ".git" || e.name === ".seam" ? [] : walk(join(dir, e.name)))
      : /\.(ts|tsx|js|java|rb|py|go)$/.test(e.name) ? [join(dir, e.name).slice(repo.length + 1)] : []);
  for (const rel of walk(repo).slice(0, 12)) {
    for (const d2 of ((build("defsInFile", rel, readFileSync(join(repo, rel), "utf-8")) ?? []) as any[]).slice(0, 6))
      targets.push([repo, rel, d2.name]);
  }
}
for (const rel of ["ts/src/codebase/seams/intent_llm.ts", "ts/src/codebase/graph.ts", "ts/src/core/graph_ir.ts"]) {
  if (!existsSync(join(REPO, rel))) continue;
  for (const d of ((build("defsInFile", rel, readFileSync(join(REPO, rel), "utf-8")) ?? []) as any[]).slice(0, 8))
    targets.push([REPO, rel, d.name]);
}
for (const [repo, rel, sym] of targets) {
  for (const fn of ["buildConsumersGraph", "buildDependencyGraph"] as const) {
    for (const dc of [false, true]) {
      const dto = build(fn, repo, rel, sym, null, dc);
      if (!dto) continue;
      let g: any; try { g = toResolvedGraph(dto); } catch { continue; }
      if ((g?.nodes?.length ?? 0) > 1) corpus.push({ name: `${fn}:${dc ? "dc" : "nodc"}:${rel}:${sym}`, data: g });
    }
  }
}

// ---- compare --------------------------------------------------------------------------------------------
let ok = 0, bad = 0, graphs = 0, prompts = 0, withTables = 0, withWrites = 0, withEndpoint = 0, trivial = 0;
let floorEligible = 0, floored = 0, maxSeams = 0;
const fails: string[] = [];

const firstLineDiff = (a: string, b: string): string => {
  const la = a.split("\n"), lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}:\n    TS: ${JSON.stringify(la[i])}\n    RS: ${JSON.stringify(lb[i])}`;
  }
  return "identical?";
};

for (const { name, data } of corpus) {
  const mk = () => { const g = from_resolved_graph(JSON.parse(JSON.stringify(data))); assign_roles(g); assign_clusters(g); return g; };
  const g0 = mk();
  if (g0.nodes.size === 0) continue;
  const base = assign_intent_seams(g0);
  if (!base.length) continue;
  graphs++;
  maxSeams = Math.max(maxSeams, base.length);
  if (base.length >= 16) floorEligible++;

  for (const verbose of [false, true]) {
    if (verbose) process.env.SEAM_DEBUG = "tierprompt"; else delete process.env.SEAM_DEBUG;
    captured = null;
    const tsSeams: Seam[] = JSON.parse(JSON.stringify(base));
    set_host_bus(new CaptureBus({}));
    try { label_focus_relevance_llm(mk(), tsSeams, "how does a booking get confirmed?", {}); }
    finally { set_host_bus(null); }

    const rs = JSON.parse(addon.decomposeIntentPrompt(
      toWire(g0), sw(base), "how does a booking get confirmed?", verbose, false));

    if (rs.trivial) { trivial++; continue; }          // no prompt is built on a one-seam footprint
    if (captured === null) { continue; }              // the TS floored it too — nothing to compare
    prompts++;
    if (rs.prompt.includes("tables: ")) withTables++;
    if (rs.prompt.includes("WRITES ")) withWrites++;
    if (rs.prompt.includes("ENDPOINT")) withEndpoint++;
    if (rs.floored.length) floored++;

    if (captured === rs.prompt) ok++;
    else { bad++; if (fails.length < 5) fails.push(`${name}[verbose=${verbose}] ${firstLineDiff(captured, rs.prompt)}`); }
  }
}
delete process.env.SEAM_DEBUG;

console.log(`intent-prompt parity: ${ok} ok / ${bad} bad   (graphs ${graphs}, prompts ${prompts}, with-tables ${withTables}, with-WRITES ${withWrites}, with-ENDPOINT ${withEndpoint}, trivial ${trivial})`);
console.log(`  floor: eligible ${floorEligible} (>=16 seams), fired ${floored}; largest footprint ${maxSeams} seams`);
for (const x of fails) console.log("  " + x);
if (bad) process.exit(1);
