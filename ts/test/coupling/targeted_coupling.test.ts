// TARGETED coupling (couplingOtherSides) — the review-impact path. Instead of a full-repo floor index, it
// computes the anchor's keys LOCALLY then greps the repo for those exact VALUES → only the files that could
// share them → grounds. O(files that mention the key), not O(repo). Two contracts: (1) it finds the OTHER
// SIDE of a real coupling (a writer of `payments` reaches the reader of `payments`), with the complementary
// edge; (2) an anchor with NO boundary returns [] instantly (no scan — the common perf/bugfix case).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { couplingOtherSides } from "../../src/codebase/coupling/index.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "targeted-")); });
afterEach(() => rmSync(REPO, { recursive: true, force: true }));

describe("couplingOtherSides — targeted value-grep, not a full-repo index", () => {
  test("a writer of a db table reaches the (untouched) reader of the same table, on the complementary edge", async () => {
    if (!available()) return;
    w("api/charge.ts", 'import { supabase } from "../db";\nexport function chargeCard(amount: number) {\n  return supabase.from("payments").insert({ amount });\n}\n');
    w("ui/Billing.ts", 'import { supabase } from "../db";\nexport function showBilling() {\n  return supabase.from("payments").select("*");\n}\n');
    // a coupling-free neighbour that merely MENTIONS the word — must not be grounded (no key of that value)
    w("util/log.ts", 'export function note() { return "wrote payments today"; }\n');

    const sides = await couplingOtherSides(REPO, "api/charge.ts", "chargeCard");
    const reader = sides.find((s) => s.file === "ui/Billing.ts");
    expect(reader).toBeDefined();
    expect(reader!.value).toBe("payments");
    expect(reader!.symbol).toBe("showBilling");
    expect(reader!.kind).toBe("db-table");
    // the writer PRODUCES the table → the other side CONSUMES it (the read edge)
    expect(reader!.edgeKind).toContain("read");
    // the prose-only file is NOT a coupling (it has no db-table key of value 'payments')
    expect(sides.some((s) => s.file === "util/log.ts")).toBe(false);
  });

  test("an anchor that touches NO boundary returns [] (the fast no-scan path)", async () => {
    if (!available()) return;
    w("util/calc.ts", "export function addOne(x: number) {\n  const base = x;\n  return base + 1;\n}\n");
    w("ui/Billing.ts", 'import { supabase } from "../db";\nexport function showBilling() {\n  return supabase.from("payments").select("*");\n}\n');
    expect(await couplingOtherSides(REPO, "util/calc.ts", "addOne")).toEqual([]);   // no key in the anchor → no grep, no scan
  });
});
