// RUST `writers` + `coupling` SHAPES — the two shapes that had no Rust at all (migration plan, Step 3).
//
// `writers` is REVERSE data-coupling: given a READ site, every WRITE site of that table repo-wide. `coupling`
// is the anchor's whole DATA BOUNDARY: each shared key it reads/writes, plus the counterparts on the other
// side. Both meet through the KEY — no import, no call, often no shared token — which is exactly what grep
// cannot answer, so what is pinned here is that the addon FINDS those and refines them by COLUMN:
//
//   1. writers: the writer of a table the anchor reads, found with nothing linking the two files.
//   2. writers: COLUMN grain — a writer that touches only columns the reader does NOT filter on is DROPPED,
//      and one whose columns can't be parsed is KEPT and flagged unverified (never drop a real write).
//   3. coupling: both roles on the anchor's own keys, with the counterpart on each.
//   4. the honest empty: a symbol that touches no key says so (`noStructure`), it does not fabricate.
//
// Hermetic (tmp repo in beforeAll, removed in afterAll), addon-guarded.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadAddon } from "../../src/codebase/grow/rust_core.js";

const repo = join(tmpdir(), "seam-rustwc-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const addon = (): any => { try { return loadAddon(); } catch { return null; } };

beforeAll(() => {
  w("package.json", `{"name":"acme","version":"1.0.0"}\n`);
  w("src/db.ts", `export const db = { booking: { findMany: (_a: unknown) => [], update: (_a: unknown) => null, create: (_a: unknown) => null } };\n`);

  // THE READER — filters `booking` on `status`. Nothing here imports or calls any writer below.
  w("src/read/list.ts", `import { db } from "../db";\n\nexport async function listBookings() {\n  return db.booking.findMany({ where: { status: "accepted" } });\n}\n`);

  // A writer that touches the SAME column the reader filters on → coupled, kept, columns verified.
  w("src/write/confirm.ts", `import { db } from "../db";\n\nexport async function confirmBooking(id: string) {\n  return db.booking.update({ where: { id }, data: { status: "accepted" } });\n}\n`);
  // A writer that touches ONLY a column the reader does not filter on → not coupled, dropped under column grain.
  w("src/write/rename.ts", `import { db } from "../db";\n\nexport async function renameBooking(id: string) {\n  return db.booking.update({ where: { id }, data: { title: "x" } });\n}\n`);
  // A writer whose write args are OPAQUE (a spread, no literal keys) → kept, unverified. Never dropped.
  w("src/write/bulk.ts", `import { db } from "../db";\n\nexport async function bulkWrite(rows: Record<string, unknown>) {\n  return db.booking.create(rows);\n}\n`);

  // No shared key at all — the honest-empty case.
  w("src/pure/math.ts", `export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe("Rust writers shape — reverse data-coupling", () => {
  test("finds the writers of the table the anchor reads, across files nothing links", () => {
    const a = addon();
    if (!a) return;
    const wr = a.projectWriters(repo, "src/read/list.ts", "listBookings");
    expect(wr.tables).toEqual(["booking"]);
    expect(wr.noStructure).toBe(false);
    const files = wr.members.map((m: any) => m.file).sort();
    expect(files).toContain("src/write/confirm.ts");
    for (const m of wr.members) {
      expect(m.table).toBe("booking");
      expect(m.edgeKind).toBe("db-write");
      expect(m.provenance).toBe("RESOLVED_PARTIAL");   // a shared-key crossing is evidence, not an asserted call
      expect(m.line).toBeGreaterThan(0);               // 1-based citation, never the 0 sentinel
    }
  });

  test("COLUMN grain: the reader's filter columns are read, and a writer that misses them is dropped", () => {
    const a = addon();
    if (!a) return;
    const wr = a.projectWriters(repo, "src/read/list.ts", "listBookings");
    expect(wr.columnGrain).toBe(true);
    expect(wr.filterColumns).toEqual([["booking", "status"]]);   // the reader's `where` keys

    const confirm = wr.members.find((m: any) => m.file === "src/write/confirm.ts");
    expect(confirm).toBeDefined();
    expect(confirm.columns).toEqual(["status"]);   // writes the column the reader filters on
    expect(confirm.colVerified).toBe(true);

    // writes only `title`, which the reader does not filter on → changing it cannot change the read's result
    expect(wr.members.some((m: any) => m.file === "src/write/rename.ts")).toBe(false);

    // opaque write args → KEPT, and honestly flagged rather than silently dropped
    const bulk = wr.members.find((m: any) => m.file === "src/write/bulk.ts");
    expect(bulk).toBeDefined();
    expect(bulk.colVerified).toBe(false);
  });

  test("a symbol that reads no table says so instead of inventing writers", () => {
    const a = addon();
    if (!a) return;
    const wr = a.projectWriters(repo, "src/pure/math.ts", "addNumbers");
    expect(wr.members.length).toBe(0);
    expect(wr.noStructure).toBe(true);
    expect(wr.reason).toBe("none");
  });
});

describe("Rust coupling shape — the anchor's data boundary", () => {
  test("groups by KEY and gives the counterpart on the other side of each role", () => {
    const a = addon();
    if (!a) return;
    const c = a.projectCoupling(repo, "src/read/list.ts", "listBookings");
    expect(c.noStructure).toBe(false);
    const key = c.keys.find((k: any) => k.kind === "db-table" && k.value === "booking");
    expect(key).toBeDefined();
    expect(key.anchorRole).toBe("reads");            // the anchor reads it…
    expect(key.sides.length).toBeGreaterThan(0);
    for (const s of key.sides) {
      expect(s.role).toBe("writes");                 // …so every counterpart is a WRITER
      expect(s.file).not.toBe("src/read/list.ts");   // the anchor is never its own counterpart
      expect(s.line).toBeGreaterThan(0);
    }
    expect(c.total).toBe(c.keys.reduce((n: number, k: any) => n + k.sides.length, 0));
  });

  test("a writer's boundary reports the READERS — the mirror direction", () => {
    const a = addon();
    if (!a) return;
    const c = a.projectCoupling(repo, "src/write/confirm.ts", "confirmBooking");
    const key = c.keys.find((k: any) => k.value === "booking");
    expect(key).toBeDefined();
    expect(key.anchorRole).toBe("writes");
    expect(key.sides.some((s: any) => s.role === "reads" && s.file === "src/read/list.ts")).toBe(true);
  });

  test("a symbol touching no shared key reports the honest empty", () => {
    const a = addon();
    if (!a) return;
    const c = a.projectCoupling(repo, "src/pure/math.ts", "addNumbers");
    expect(c.keys.length).toBe(0);
    expect(c.noStructure).toBe(true);
    expect(c.reason).toBe("none");
  });
});
