// AUTO-ROUTE (#3, blast-radius routing) — an `--auto --intent` grow assumes the intent is a FLOW. But an agent
// (via grow_intent) routinely hands it a BLAST-RADIUS / find-usages intent ("what breaks if I change X"), for
// which a flow grow returns a noFlow, half-empty region map when the engine already answers it precisely as the
// `impact` shape. With `--auto-route` the intent is routed FIRST (route.ts, the semantic shape router) and a
// non-flow question is answered as that structural shape instead. This pins the BEHAVIOUR: (a) a blast-radius
// intent is rerouted to a `shape: "impact"` model that enumerates ALL transitive consumers across files, and
// (b) a genuine flow intent is left untouched (grows a flow, no reroute). Routing is SEMANTIC → guards on a
// backend (available()); offline it stays a flow grow, so the suite is green everywhere.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let REPO = "";

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-autoroute-"));
  const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  // normalizeMember is the anchor; three files consume it → a 3-symbol/3-file blast radius.
  w("src/member.ts", `export interface Member { id: string; name: string; }\nexport function normalizeMember(m: Member): Member {\n  return { id: m.id.trim(), name: m.name.trim() };\n}\n`);
  w("src/roster.ts", `import { normalizeMember, Member } from "./member.js";\nexport function buildRoster(ms: Member[]): Member[] {\n  return ms.map(normalizeMember);\n}\n`);
  w("src/report.ts", `import { normalizeMember, Member } from "./member.js";\nexport function memberReport(m: Member): string {\n  const n = normalizeMember(m);\n  return \`\${n.id}: \${n.name}\`;\n}\n`);
  w("src/export.ts", `import { normalizeMember, Member } from "./member.js";\nexport function exportMember(m: Member): string {\n  return JSON.stringify(normalizeMember(m));\n}\n`);
  execSync(`git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init`, { cwd: REPO });
});
afterAll(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); });

const run = (args: string[]) => {
  const seams = join(REPO, "out.json");
  const r = spawnSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto", "--data-coupling", "floor",
    "--anchor-file", "src/member.ts", "--symbol", "normalizeMember", "--format", "agent", "--emit-seams", seams, ...args],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });
  let model: any = null;
  try { model = JSON.parse(readFileSync(seams, "utf-8")); } catch { /* no model emitted */ }
  return { r, model };
};

describe("--auto-route — a blast-radius intent is answered as the impact shape, a flow intent stays a flow", () => {
  test("a blast-radius intent reroutes to shape:impact and enumerates every transitive consumer across files", () => {
    if (!available()) return;   // routing is semantic — needs an LLM backend (and tree-sitter)
    const { model } = run(["--intent", "what breaks if I change normalizeMember", "--auto-route"]);
    expect(model?.shape).toBe("impact");                                   // rerouted, not a flow grow
    const affected = new Set<string>((model.surface ?? []).map((s: any) => s.symbol)
      .concat((model.affected ?? model.impacted ?? []).map((s: any) => s.symbol ?? s.name)));
    // all three consumers are in the blast radius (across their three files)
    for (const sym of ["buildRoster", "memberReport", "exportMember"]) expect(affected.has(sym)).toBe(true);
  }, 60000);

  test("a genuine flow intent is NOT rerouted — it still grows a flow (no impact shape)", () => {
    if (!available()) return;
    const { model } = run(["--intent", "how is a member roster built", "--auto-route"]);
    expect(model?.shape).not.toBe("impact");                              // stayed a flow grow
  }, 60000);

  test("WITHOUT --auto-route a blast-radius intent is left as a flow grow (opt-in; no behavior change by default)", () => {
    if (!available()) return;
    const { model } = run(["--intent", "what breaks if I change normalizeMember"]);
    expect(model?.shape).not.toBe("impact");                              // default path untouched
  }, 60000);
});
