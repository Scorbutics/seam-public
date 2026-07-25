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

  // DETERMINISM (regression): the candidate list comes from `grepFiles`, which shells out to `rg -l`. ripgrep
  // walks the tree on a THREAD POOL, so its emission order is a RACE — the same repo + value yields a different
  // permutation every run. This path then CAPS the candidates (_TARGETED_CAND_CAP) and stops materialising at
  // READER_CAP, so an unordered candidate list made the cap a lottery: the same query answered differently run
  // to run (cal.com `getBusyTimes` reported 1..6 cross-stack crossings across identical cold runs). The contract
  // is that a repeated query over an UNCHANGED repo returns the SAME crossings — grepFiles is totally ordered.
  //
  // The repo is built WIDE (enough `payments` mentions to exceed the caps, spread over many directories) so
  // ripgrep genuinely parallelises the walk — that is what makes this test non-vacuous.
  test("repeating the same query over an unchanged repo returns the SAME crossings (rg order is a race)", async () => {
    if (!available()) return;
    w("api/charge.ts", 'import { supabase } from "../db";\nexport function chargeCard(amount: number) {\n  return supabase.from("payments").insert({ amount });\n}\n');
    // 400 candidate files across 20 directories that MENTION the key — the bulk that makes rg's walk race and
    // pushes the candidate set past the cap. Prose-only, so they can never be a crossing themselves.
    for (let i = 0; i < 400; i++) w(`pkg${String(i % 20).padStart(2, "0")}/note${String(i).padStart(3, "0")}.ts`, `export const n${i} = "payments ledger note ${i}";\n`);
    // REAL readers of the same table, scattered through that crowd so no fixed prefix of any permutation
    // trivially contains them all.
    for (let i = 0; i < 12; i++) w(`pkg${String((i * 7) % 20).padStart(2, "0")}/reader${i}.ts`, `import { supabase } from "../db";\nexport function showBilling${i}() {\n  return supabase.from("payments").select("*");\n}\n`);

    const runs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sides = await couplingOtherSides(REPO, "api/charge.ts", "chargeCard");
      runs.push(JSON.stringify(sides));
    }
    expect(runs.length).toBe(5);
    expect(runs.every((r) => r === runs[0])).toBe(true);   // byte-identical across repeats — no rg-order lottery
    expect(JSON.parse(runs[0]).length).toBeGreaterThan(0); // non-vacuous: the query really does resolve crossings
  });

  test("an anchor that touches NO boundary returns [] (the fast no-scan path)", async () => {
    if (!available()) return;
    w("util/calc.ts", "export function addOne(x: number) {\n  const base = x;\n  return base + 1;\n}\n");
    w("ui/Billing.ts", 'import { supabase } from "../db";\nexport function showBilling() {\n  return supabase.from("payments").select("*");\n}\n');
    expect(await couplingOtherSides(REPO, "util/calc.ts", "addOne")).toEqual([]);   // no key in the anchor → no grep, no scan
  });
});
