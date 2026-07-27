// REGRESSION: when the grow WALK reaches a class/interface as a DEPENDENCY (a return-type / value class), its
// DOWN footprint must surface only the methods the reaching callers actually INVOKE — not every method. A class
// anchored DIRECTLY (the seed / a --symbol query) still shows its FULL method decomposition. Without this guard a
// util/value class (BookingsIcs, PersistentEntityId) explodes into all of getDescription/serialize/equals/
// hashCode/toString and floods the Supporting tier. Hermetic tmp repo; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { build_footprint } from "../helpers/scan.js";
import { available } from "../../src/codebase/atoms.js";

const repo = join(tmpdir(), "seam-walk-denoise-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  // loadBookings returns a BookingsIcs and CALLS only getSummary on it; BookingsIcs has 9 methods.
  w("src/BookingsController.java",
    `package a;\nimport a.BookingsIcs;\npublic class BookingsController {\n  public BookingsIcs loadBookings(){ BookingsIcs ics = new BookingsIcs(); ics.getSummary(); return ics; }\n}\n`);
  w("src/BookingsIcs.java",
    `package a;\npublic class BookingsIcs {\n  public String getDescription(){ return ""; }\n  public String getSummary(){ return ""; }\n  public String toContent(){ return ""; }\n  public String serialize(){ return ""; }\n  public String getFilename(){ return ""; }\n  public boolean equals(Object o){ return true; }\n  public int hashCode(){ return 0; }\n  public String toString(){ return ""; }\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("walk method de-noise — a dependency class surfaces only its CALLED methods", () => {
  test("the WALK pulls only the invoked method (getSummary), not all of BookingsIcs", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(repo, "src/BookingsController.java", "loadBookings",
      { maxSteps: 8, maxNodes: 40, bidirectional: true, dataCoupling: false } as any);
    const icsMethods = data.nodes
      .filter((n: any) => n.file.endsWith("BookingsIcs.java") && n.kind === "method")
      .map((n: any) => n.symbol).sort();
    expect(icsMethods).toEqual(["getSummary"]);   // ONLY the called one — not getDescription/serialize/equals/…
  });

  test("the SEED anchor still shows BookingsIcs' FULL method decomposition (display fix preserved)", async () => {
    if (!available()) return;
    const g: any = await build_footprint(repo, "src/BookingsIcs.java", "BookingsIcs", { direction: "down", dataCoupling: false });
    const methods = g.nodes.filter((n: any) => n.id !== "n1" && n.kind === "method").map((n: any) => n.symbol);
    // every declared method (constructor excluded) — the direct anchor is the full-decomposition privilege
    expect(methods.sort()).toEqual(["equals", "getDescription", "getFilename", "getSummary", "hashCode", "serialize", "toContent", "toString"]);
  });
});
