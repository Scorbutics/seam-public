// The def table (whole-repo recall enumeration) is a full-repo PARSE — the dominant COLD cost of an --intent
// grow / anchor selection (measured ~1.05s of a 2.7s cal.com grow, paid again every fresh process). It now
// persists each file's extracted defs to `.seam/def-table.json` (content-keyed by mtime/size), so a warm
// re-run re-parses only CHANGED files — the impl/callsite-index pattern. This pins the CORRECTNESS contract
// (NOT timing):
//   1. whole-repo enumeration is BYTE-IDENTICAL with the cache ON (cold + warm) vs OFF (SEAM_INDEX_CACHE=0);
//   2. the cache persists to .seam/ and is REUSED on a second read (no behaviour change);
//   3. an EDIT (a new def) is picked up — the merged result updates, not stale.
// Uses .ts files only (the regex `defs_in_file` extractor) so it needs NO tree-sitter → green offline / in the
// .vsix. Hermetic tmp repo; mirrors impl_index_incremental.test.ts.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enumerate_defs, _resetDefTableMem } from "../../src/codebase/scan/def_table.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
const sig = (defs: { name: string; kind: string; file: string; signature: string; enclosing: string; doc: string }[]) =>
  defs.map((d) => `${d.name}|${d.kind}|${d.file}|${d.signature}|${d.enclosing}|${d.doc}`).join("\n");
// the whole-repo table is memoised IN MEMORY per process; these tests exercise the DISK cache + edit-pickup
// across what would be SEPARATE runs, so clear the memo before each enumerate to simulate a fresh process.
const fresh = async (limit: number) => { _resetDefTableMem(); return enumerate_defs(REPO, limit, undefined, { moduleDefs: true }); };

beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "def-table-")); _resetDefTableMem(); });
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); delete process.env.SEAM_INDEX_CACHE; _resetDefTableMem(); });

describe("def table — incremental disk cache (correctness, not timing)", () => {
  test("whole-repo enumeration is byte-identical cache ON (cold+warm) vs OFF, and persists to .seam/", async () => {
    w("src/booking.ts", "export class Booking {\n  create() { return 1; }\n}\nexport function helper() { return 2; }\n");
    w("src/user.ts", "export const userName = 'x';\nexport function ensureUser() { return true; }\n");

    process.env.SEAM_INDEX_CACHE = "0";
    const direct = await fresh(15000);
    delete process.env.SEAM_INDEX_CACHE;
    const cold = await fresh(15000);   // builds the disk cache
    const warm = await fresh(15000);   // reuses it

    expect(direct.length).toBeGreaterThan(0);
    expect(sig(cold)).toBe(sig(direct));   // cache must not change recall
    expect(sig(warm)).toBe(sig(direct));   // reuse must not change recall
    expect(existsSync(join(REPO, ".seam", "def-table.json"))).toBe(true);
  });

  test("an edit (a new def) is picked up — not served stale", async () => {
    w("src/svc.ts", "export function alpha() { return 1; }\n");
    const before = await fresh(15000);
    expect(before.some((d) => d.name === "alpha")).toBe(true);
    expect(before.some((d) => d.name === "beta")).toBe(false);

    // re-write the SAME file with an extra def (mtime/size change → that file is re-scanned)
    w("src/svc.ts", "export function alpha() { return 1; }\nexport function beta() { return 2; }\n");
    const after = await fresh(15000);
    expect(after.some((d) => d.name === "beta")).toBe(true);   // the edit is reflected, not the stale cache
  });
});
