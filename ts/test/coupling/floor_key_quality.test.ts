// REPRODUCTION of the proprietary-repo "the" hub: the raw-SQL floor adapter matched ENGLISH PROSE
// ("…select … from the …") as a `db-table` read, so the generic word `the` became a shared-key boundary
// read in 32 files — spawning a fan of false suggested seams. Two deterministic fixes locked here:
//   • a universal plausibility filter on scan_file_keys (drops "the"/prose/too-short from ANY adapter)
//   • raw-SQL masks comments (SQL-looking text in a doc-comment is not a real query)
// Real tables / routes / keys must still pass.
import { describe, expect, test } from "bun:test";
import { scan_file_keys } from "../../src/codebase/coupling/index.js";

const keys = (file: string, text: string) => scan_file_keys(file, text);
const tables = (text: string) => keys("X.java", text).filter((h) => h.kind === "db-table").map((h) => h.value);

describe("floor key-quality guard (kills the raw-SQL 'the' false-coupling)", () => {
  test("prose 'select … from the …' inside a string yields no 'the' table (plausibility)", () => {
    expect(tables('String msg = "Select the scope of advice report from the member record";')).not.toContain("the");
  });
  test("a generic-word table in a real SQL string is dropped (plausibility)", () => {
    expect(tables('String q = "SELECT id FROM the";')).toEqual([]);          // 'the' → dropped
    expect(tables('String q = "DELETE FROM and";')).toEqual([]);             // 'and' → dropped
  });
  test("a REAL table in a real SQL string still resolves", () => {
    expect(tables('String q = "SELECT id FROM member_collection WHERE x=1";')).toContain("member_collection");
    expect(tables('String q = "INSERT INTO payments (a) VALUES (1)";')).toContain("payments");
  });
  test("SQL-shaped text OUTSIDE a string (bare prose / code / comment) is ignored (string-region scan)", () => {
    expect(tables("// SELECT secret FROM hidden_table\nint x = 1;")).not.toContain("hidden_table");   // comment
    expect(tables("please select the rows from members manually")).toEqual([]);                       // bare prose
  });
  test("real routes / keys are unaffected by the floor guard", () => {
    expect(keys("C.java", '@GetMapping("/owners/{id}")\nvoid g(){}').some((h) => h.kind === "http-route" && h.value === "/owners/*")).toBe(true);
  });
});

describe("floor scan size guard (skips minified/generated bundles)", () => {
  test("a >1MB file is skipped entirely (no char-scan, no keys) — guards the webapp vendor-bundle slowdown", () => {
    const big = 'var x="' + "a".repeat(1_100_000) + '";var q="SELECT id FROM users";';   // a real SQL string, but in a 1.1MB file
    expect(big.length).toBeGreaterThan(1_000_000);
    expect(keys("vendor.bundle.js", big)).toEqual([]);   // skipped despite containing a valid SQL read
  });
  test("a normal-sized file with the same SQL still resolves (cap doesn't over-reach)", () => {
    expect(tables('var q = "SELECT id FROM users";')).toContain("users");
  });
});
