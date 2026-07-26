// RUST TARGETED BRIDGE — the cross-stack overlay (`couplingOtherSides`) ported to the addon. Pins the three
// properties that make the overlay trustworthy, against `seam_core.node` directly:
//
//   1. It FINDS the crossing no import/call edge links — a backend writer and a frontend reader of the same
//      table, with nothing textual between them. That is the whole moat.
//   2. It agrees with the TS bridge BYTE FOR BYTE — same crossings, same order.
//   3. It STATES its bounds. When the candidate walk stops early (READER_CAP here), the truncation says which
//      key, how far it got, out of how many, and why. A bounded answer presented as complete is the failure
//      mode this exists to prevent, so the truncation is asserted as strictly as the crossings are.
//
// Hermetic (tmp repo built in beforeAll, removed in afterAll), addon-guarded so a checkout with no built
// addon stays green. Deterministic FLOOR only — no LLM key proposal on either side.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { couplingOtherSides } from "../../src/codebase/coupling/index.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { loadAddon } from "../../src/codebase/grow/rust_core.js";

const repo = join(tmpdir(), "seam-rustbridge-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const addon = (): any => { try { return loadAddon(); } catch { return null; } };
const ser = (xs: any[]) => xs.map((s) => `${s.kind}|${s.value}|${s.file}|${s.symbol}|${s.edgeKind ?? s.edge_kind}`).join("\n");

beforeAll(() => {
  w("package.json", `{"name":"br","version":"1.0.0"}\n`);
  // The ANCHOR writes the `invoice` table. Nothing here imports or calls anything below.
  w("src/api/save.ts", `import { db } from "../db";\n\nexport async function saveInvoice(row: { id: string }) {\n  return db.from("invoice").insert(row);\n}\n`);
  w("src/db.ts", `export const db = { from: (_t: string) => ({ insert: (_r: unknown) => null, select: (_c: string) => null }) };\n`);
  // The OTHER SIDE: readers of the same table, in files with NO edge to the anchor. More than READER_CAP (6)
  // of them, so the walk must stop early AND say so.
  for (let i = 1; i <= 9; i++) {
    w(`src/ui/panel${i}.ts`, `import { db } from "../db";\n\nexport function renderPanel${i}() {\n  return db.from("invoice").select("*");\n}\n`);
  }
  // A TEST file that also reads the table — a fixture, never a real counterpart. It must not be materialised.
  w("src/ui/panel.test.ts", `import { db } from "../db";\n\nexport function fixture() {\n  return db.from("invoice").select("*");\n}\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("Rust targeted bridge — the cross-stack overlay", () => {
  test("finds the shared-table crossing that no import or call edge links", () => {
    const a = addon();
    if (!a) return;
    const { sides } = a.couplingOtherSides(repo, "src/api/save.ts", "saveInvoice");
    expect(sides.length).toBeGreaterThan(0);
    for (const s of sides) {
      expect(s.kind).toBe("db-table");
      expect(s.value).toBe("invoice");
      expect(s.provenance).toBe("RESOLVED_PARTIAL");   // a shared-name crossing is evidence, never an asserted call
      expect(s.file.startsWith("src/ui/panel")).toBe(true);
      expect(s.file).not.toContain(".test.");          // a test file is a FIXTURE, not a counterpart
    }
  });

  test("byte-identical to the TS bridge — same crossings, same order", async () => {
    const a = addon();
    if (!a) return;
    const ctx = new EngineCtx();
    const ts = await couplingOtherSides(repo, "src/api/save.ts", "saveInvoice", { llm: false }, ctx);
    const rust = a.couplingOtherSides(repo, "src/api/save.ts", "saveInvoice");
    expect(ser(rust.sides)).toBe(ser(ts));
    expect(rust.truncations.map((t: any) => `${t.kind}|${t.value}|${t.scanned}|${t.total}|${t.reason}`))
      .toEqual(ctx.couplingTruncations.map((t: any) => `${t.kind}|${t.value}|${t.scanned}|${t.total}|${t.reason}`));
  });

  test("states the bound it stopped at instead of presenting a capped walk as complete", () => {
    const a = addon();
    if (!a) return;
    const { sides, truncations } = a.couplingOtherSides(repo, "src/api/save.ts", "saveInvoice");
    // 9 readers, READER_CAP 6 → the walk stops early, and that has to be SAID.
    expect(sides.length).toBe(6);
    const t = truncations.find((x: any) => x.value === "invoice");
    expect(t).toBeDefined();
    expect(t.reason).toBe("reader-cap");
    expect(t.scanned).toBeLessThan(t.total);   // it stopped before the candidate list was exhausted
    expect(t.total).toBeGreaterThan(6);
  });

  test("the crossing set is a pure function of the repo — repeated runs are identical", () => {
    const a = addon();
    if (!a) return;
    // `rg -l` emits in thread-completion order, so an unsorted candidate list makes the READER_CAP prefix a
    // lottery: the same query answered differently run to run. grep_files normalises to path order.
    const runs = [0, 1, 2].map(() => ser(a.couplingOtherSides(repo, "src/api/save.ts", "saveInvoice").sides));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });
});
