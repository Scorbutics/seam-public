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
  test("prose 'select … from the …' does NOT yield a 'the' db-table", () => {
    expect(tables('String msg = "Select the scope of advice report from the member record";')).not.toContain("the");
  });
  test("a generic-word table from ANY SQL shape is dropped", () => {
    expect(tables("SELECT id FROM the")).toEqual([]);                 // 'the' → dropped by plausibility
    expect(tables("DELETE FROM and")).toEqual([]);                    // 'and' → dropped
  });
  test("a REAL table in real SQL still resolves", () => {
    expect(tables("SELECT id FROM member_collection WHERE x=1")).toContain("member_collection");
    expect(tables("INSERT INTO payments (a) VALUES (1)")).toContain("payments");
  });
  test("commented-out SQL is ignored (masked), so it can't seed a phantom table", () => {
    expect(tables("// SELECT secret FROM hidden_table\nint x = 1;")).not.toContain("hidden_table");
  });
  test("real routes / keys are unaffected by the floor guard", () => {
    expect(keys("C.java", '@GetMapping("/owners/{id}")\nvoid g(){}').some((h) => h.kind === "http-route" && h.value === "/owners/*")).toBe(true);
  });
});
