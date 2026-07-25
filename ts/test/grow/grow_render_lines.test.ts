// REGRESSION — the GROW renders (`--format agent` / `--format concern`) must cite 1-BASED lines: the line they
// print has to be the line that actually holds the declaration/call. They were the last shape still printing the
// engine's raw 0-BASED scan value, so every citation was one line high (`core.target (src/core.ts:2)` for a
// declaration on line 3) — an off-by-one that sends the reader to the line ABOVE (usually blank or a comment).
// The seam MODEL is the conversion point (seams/emit.ts, core/lines.ts): the graph IR stays 0-based because
// scan/detect.ts slices the file with `node.start/end` as row INDICES, so the +1 happens once, on the way out.
//
// The expectation is DERIVED FROM THE FIXTURE — every cited line is re-read from the tmp repo and must contain
// the symbol the render claims sits there. Nothing is hard-coded to a number. In-process (grow → decompose →
// render), guarded on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { from_resolved_graph } from "../../src/core/graph_ir.js";
import { decompose } from "../../src/codebase/codebase.js";
import { renderAgent, renderConcern } from "../../src/codebase/llm_context.js";

let REPO = "";
const SRC: Record<string, string> = {
  // Every declaration is deliberately pushed OFF the first line (leading comment/import) so a 0-based value and
  // a 1-based one differ, and the wrong one lands on a comment or a blank line.
  "src/core.ts": [
    "// core — the flow's target lives BELOW this comment, on purpose",
    "import { store } from \"./store\";",
    "",
    "export function target(id: string) {",
    "  return store(id);",
    "}",
    "",
  ].join("\n"),
  "src/store.ts": [
    "// the grounded sink",
    "",
    "export function store(id: string) {",
    "  return { id };",
    "}",
    "",
  ].join("\n"),
  "src/top.ts": [
    "// the entry point",
    "import { target } from \"./core\";",
    "",
    "export function top(id: string) {",
    "  return target(id);",
    "}",
    "",
  ].join("\n"),
};

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-grow-lines-"));
  for (const [rel, text] of Object.entries(SRC)) {
    const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
  }
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

const INTENT = "how does the flow reach the store";
// The FIXTURE-derived truth: the 1-based line holding a piece of source text.
const lineOf = (rel: string, needle: string): number => {
  const i = SRC[rel].split("\n").findIndex((l) => l.includes(needle));
  expect(i).toBeGreaterThanOrEqual(0);   // the fixture really contains it
  return i + 1;
};

async function renders(): Promise<{ agent: string; concern: string }> {
  const grown: any = await grow_to_terminals(REPO, "src/top.ts", "top", { maxSteps: 20, maxNodes: 80, dataCoupling: false } as any);
  const data = Array.isArray(grown) ? grown[0] : grown;
  const model: any = await decompose(from_resolved_graph(data), { repo: REPO, useLlm: false, intent: INTENT, skeleton: true });
  return {
    agent: renderAgent(model, { tokenBudget: 8000, intent: INTENT }),
    concern: renderConcern(model, { intent: INTENT }),
  };
}

// EVERY `symbol (src/….ts:N)` citation in a render must land on a line that really mentions that symbol.
// Returns how many citations were checked so the assertion can't pass vacuously on an empty render.
const assertCitationsLandOnTheirSymbol = (out: string): number => {
  let checked = 0;
  for (const m of out.matchAll(/([A-Za-z_$][\w$.]*) \((src\/[\w./-]+):(\d+)\)/g)) {
    const [, sym, rel, ln] = m;
    const tail = sym.split(".").pop()!;
    const src = SRC[rel]; if (!src || !src.includes(tail)) continue;   // not a symbol of this fixture file (e.g. a boundary handle)
    // Assert on "<citation> → <the line it points at>" so a failure PRINTS the wrong line, not just `false`.
    expect(`${sym} (${rel}:${ln}) → ${src.split("\n")[Number(ln) - 1] ?? "<past EOF>"}`)
      .toMatch(new RegExp(`→ .*\\b${tail}\\b`));   // the ARROW anchors the check to the cited LINE's text
    checked++;
  }
  return checked;
};

describe("grow renders cite REAL (1-based) lines", () => {
  test("--format agent: the anchor and its callee are cited at the line that declares them", async () => {
    if (!available()) return;
    const { agent } = await renders();
    expect(agent).toContain(`src/top.ts:${lineOf("src/top.ts", "export function top(")}`);
    expect(agent).toContain(`src/core.ts:${lineOf("src/core.ts", "export function target(")}`);
    expect(assertCitationsLandOnTheirSymbol(agent)).toBeGreaterThanOrEqual(2);
  });

  test("--format concern: every cited line holds the symbol the render names", async () => {
    if (!available()) return;
    const { concern } = await renders();
    expect(concern).toContain(`src/top.ts:${lineOf("src/top.ts", "export function top(")}`);
    expect(assertCitationsLandOnTheirSymbol(concern)).toBeGreaterThanOrEqual(1);
  });
});
