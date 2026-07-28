// TARGETED coupling (couplingOtherSides) — the review-impact path. Instead of a full-repo floor index, it
// computes the anchor's keys LOCALLY then greps the repo for those exact VALUES → only the files that could
// share them → grounds. O(files that mention the key), not O(repo). Two contracts: (1) it finds the OTHER
// SIDE of a real coupling (a writer of `payments` reaches the reader of `payments`), with the complementary
// edge; (2) an anchor with NO boundary returns [] instantly (no scan — the common perf/bugfix case).
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { couplingOtherSides } from "../helpers/coupling.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { COUPLING } from "../../src/codebase/coupling/config.js";
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
  // permutation every run. This path stops materialising at READER_CAP (and, back then, also sliced the candidate
  // list to a fixed prefix), so an unordered candidate list made the stop a lottery: the same query answered differently run
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

  // RECALL (regression): the candidate list used to be sliced to a fixed prefix (`_TARGETED_CAND_CAP = 200`),
  // which bounded the INPUT when the thing that needed bounding was the COST. Once grepFiles was made totally
  // ordered, that prefix became a STABLE blind spot: any counterpart sorting after the 200th candidate was
  // permanently invisible. Measured on cal.com `db-table booking` — 1147 candidates, 26 real complementary
  // writers, only 2 inside the first 200, so the answer stably reported 2 of the 6 it is allowed to materialise.
  // Here the readers are deliberately parked BEYOND any naive prefix (400 mention-only pads sort first), so a
  // pipeline that caps its input reports NOTHING and this test fails; the cost is now bounded by READER_CAP +
  // the run's scan budget instead. Verified non-vacuous against the pre-fix bridge: 0 crossings, not 6.
  test("counterparts sorted BEYOND a naive candidate prefix are still found (cost is capped, input is not)", async () => {
    if (!available()) return;
    w("api/charge.ts", 'import { supabase } from "../db";\nexport function chargeCard(amount: number) {\n  return supabase.from("payments").insert({ amount });\n}\n');
    // 400 mention-only files that sort FIRST (`pad/…` < `zz/…`) — they can never be a crossing, they only crowd
    // out the real ones. 400 > any prefix the old cap allowed.
    for (let i = 0; i < 400; i++) w(`pad/n${String(i).padStart(4, "0")}.ts`, `export const n${i} = "payments ledger note ${i}";\n`);
    // 7 REAL readers of the table, all sorting after every pad → all beyond the old 200-candidate prefix. Seven,
    // not six, so the READER_CAP stop fires with candidates left over and the truncation must be reported.
    for (let i = 0; i < 7; i++) w(`zz/reader${i}.ts`, `import { supabase } from "../db";\nexport function showBilling${i}() {\n  return supabase.from("payments").select("*");\n}\n`);

    const ctx = new EngineCtx();
    const sides = await couplingOtherSides(REPO, "api/charge.ts", "chargeCard", {}, ctx);
    const readers = sides.filter((s) => s.file.startsWith("zz/reader"));
    expect(readers.length).toBe(COUPLING.readerCap);            // the full ceiling, not the 0 a 200-prefix yields
    for (const r of readers) { expect(r.value).toBe("payments"); expect(r.kind).toBe("db-table"); expect(r.edgeKind).toContain("read"); }
    expect(sides.some((s) => s.file.startsWith("pad/"))).toBe(false);   // no padding: a mention is not a coupling

    // HONESTY — stopping at the cap with candidates unscanned is TRUNCATION, and it is reported, never silent.
    const t = sides.truncations.find((x) => x.value === "payments");
    expect(t).toBeDefined();
    expect(t!.reason).toBe("reader-cap");
    expect(t!.scanned).toBeLessThan(t!.total);
  });

  // The recall above must not come back as an rg-order lottery: with the input cap gone the stop is READER_CAP,
  // which still consumes a PREFIX — so the prefix must stay a pure function of the repo across cold runs.
  test("the recovered counterparts are the SAME set on every run (the READER_CAP stop is order-stable)", async () => {
    if (!available()) return;
    w("api/charge.ts", 'import { supabase } from "../db";\nexport function chargeCard(amount: number) {\n  return supabase.from("payments").insert({ amount });\n}\n');
    for (let i = 0; i < 400; i++) w(`pad/n${String(i).padStart(4, "0")}.ts`, `export const n${i} = "payments ledger note ${i}";\n`);
    for (let i = 0; i < 12; i++) w(`zz/reader${String(i).padStart(2, "0")}.ts`, `import { supabase } from "../db";\nexport function showBilling${i}() {\n  return supabase.from("payments").select("*");\n}\n`);
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) runs.push(JSON.stringify(await couplingOtherSides(REPO, "api/charge.ts", "chargeCard", {}, new EngineCtx())));
    expect(runs.every((r) => r === runs[0])).toBe(true);
    expect(JSON.parse(runs[0]).length).toBe(COUPLING.readerCap);
  });

  test("an anchor that touches NO boundary returns [] (the fast no-scan path)", async () => {
    if (!available()) return;
    w("util/calc.ts", "export function addOne(x: number) {\n  const base = x;\n  return base + 1;\n}\n");
    w("ui/Billing.ts", 'import { supabase } from "../db";\nexport function showBilling() {\n  return supabase.from("payments").select("*");\n}\n');
    expect(await couplingOtherSides(REPO, "util/calc.ts", "addOne")).toHaveLength(0);   // no key in the anchor → no grep, no scan
  });
});
