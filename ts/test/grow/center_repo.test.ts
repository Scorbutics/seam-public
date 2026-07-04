// CENTER-FIRST (repo-wide, NO grow, NO anchor) — picking a concern's mechanism from an intent phrase. The
// STRUCTURE casts a lexical recall net (tests + DTO/input/output files excluded); the LLM judge (injected)
// makes the pick, degrading to the lexical floor offline. Pure over a hermetic tmp repo; no tree-sitter (the
// def enumeration is regex-based, so this runs everywhere).
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
  w("src/dto/create-booking.input.ts", `export class CreateBookingInput { name!: string; }\n`);   // DTO — name matches, but .input. file → excluded
  w("test/booking.spec.ts", `export function createBookingCase() {}\n`);                            // test — excluded
  w("src/util/logger.ts", `export function log(x: string) { return x; }\n`);                        // off-intent
  w("src/bookings-constants.ts", `export class BookingsConstants { static readonly MAX = 5; }\n`);    // constants — a dead-end, must be excluded
  w("src/booking-status.ts", `export enum BookingStatus { Pending, Confirmed }\n`);                   // enum data — must be excluded
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("detectCentersRepoWide — recall net + pick (no grow, no anchor)", () => {
  test("the lexical floor surfaces the mechanism; tests + DTO files are excluded from the net", async () => {
    const centers = await detectCentersRepoWide(repo, "how are bookings created and confirmed", { k: 4 });   // no judge → lexical floor
    const syms = centers.map((c) => c.symbol);
    expect(syms).toContain("createBooking");                          // found repo-wide, no grow, no anchor
    expect(syms).not.toContain("CreateBookingInput");                // .input.ts DTO file excluded from the net
    expect(syms).not.toContain("createBookingCase");                 // test file excluded
    expect(centers.every((c) => !/logger/.test(c.file))).toBe(true); // off-intent def not scored in
    expect(syms).not.toContain("BookingsConstants");                 // *Constants data class — a dead-end (Acme bug)
    expect(syms).not.toContain("BookingStatus");                     // enum — excluded
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
