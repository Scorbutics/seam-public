// CENTER-FIRST (repo-wide, NO grow, NO anchor) — picking a concern's mechanism from an intent phrase. STRUCTURE
// casts a WIDE lexical recall net; the LLM judge (injected) makes the pick, degrading to the lexical floor
// offline. The only hardcoded exclusions are CONVENTIONS/config, never per-repo guesses: standard tests (unless
// --include-tests), `.d.ts` type-decls, structural `enum`/`module` kinds, and the dev's own `--exclude` dirs.
// Archived/data/off-intent filtering is the LLM's job (semantic). Pure over a hermetic tmp repo; regex defs, no
// tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectCentersRepoWide } from "../../src/codebase/grow/center_repo.js";

const repo = join(tmpdir(), "seam-centerfirst-" + process.pid);
beforeAll(() => {
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
  w("package.json", `{ "name": "cf", "version": "1.0.0" }\n`);
  w("src/services/booking-service.ts", `export function createBooking(x: string) { return x; }\nexport function confirmBooking(id: string) { return id; }\n`);   // the mechanism(s)
  w("src/booking-status.ts", `export enum BookingStatus { Pending, Confirmed }\n`);                   // enum — structural kind, excluded
  w("test/booking.spec.ts", `export function createBookingCase() {}\n`);                              // test convention — excluded (unless --include-tests)
  w("src/util/logger.ts", `export function log(x: string) { return x; }\n`);                          // off-intent → score 0
  w("archived/old-booking.ts", `export function reBookingArchive(x: string) { return x; }\n`);        // a per-repo dead dir — only excluded via --exclude
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("detectCentersRepoWide — recall net + pick (no grow, no anchor)", () => {
  test("the lexical floor surfaces the mechanism; tests + enum kind excluded; archived is NOT excluded by default", async () => {
    const syms = (await detectCentersRepoWide(repo, "how are bookings created and confirmed", { k: 8 })).map((c) => c.symbol);   // no judge → lexical floor
    expect(syms).toContain("createBooking");                          // found repo-wide, no grow, no anchor
    expect(syms).not.toContain("createBookingCase");                 // test file — convention exclusion
    expect(syms).not.toContain("BookingStatus");                     // enum — structural kind exclusion
    expect(syms.every((s) => s !== "log")).toBe(true);               // off-intent def not scored in
    expect(syms).toContain("reBookingArchive");                      // 'archived/' is NOT hardcoded-excluded (per-repo, the LLM/dev decides)
  });

  test("the dev's --exclude drops their own dead dirs (not the engine's guess)", async () => {
    const syms = (await detectCentersRepoWide(repo, "how are bookings created and confirmed", { k: 8, excludeDirs: ["archived"] })).map((c) => c.symbol);
    expect(syms).toContain("createBooking");
    expect(syms).not.toContain("reBookingArchive");                  // now excluded — because the DEV said so
  });

  test("an injected judge (the LLM path) overrides the lexical floor — the pick is the model's", async () => {
    const judge = async (_intent: string, cands: { symbol: string; file: string }[]) => {
      const c = cands.find((x) => x.symbol === "confirmBooking");
      return c ? [`${c.symbol} ${c.file}`] : null;
    };
    const centers = await detectCentersRepoWide(repo, "how are bookings created and confirmed", { judge });
    expect(centers.map((c) => c.symbol)).toEqual(["confirmBooking"]);
  });
});
