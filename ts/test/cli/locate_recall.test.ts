// `--locate` MUST NOT REPORT A FALSE NEGATIVE — it is the command an agent trusts when it is lost.
//
// THE DEFECT (measured 2026-07-31 on cal.com). `locate_name` enumerated defs with a hard cap of 4000, and
// `enumerate_files` returns the INSTANT it reaches the limit, in file order. On a monorepo that means most of
// the repo is never searched — and the command then prints:
//
//   No definition of 'BookingRepository' found in <repo>.
//   It may be an external package symbol, defined dynamically, or spelled differently — grep is the right next step.
//
// for `export class BookingRepository` sitting at BookingRepository.ts:375. A false negative dressed as a fact,
// and it actively routes the caller to grep. Measured consequence: an agent spent 10 of its 32 tool calls
// hunting for an anchor with find/ls (bench/grep-vs-seam, cal-ab3) — the single largest block in that budget.
//
// SECOND DEFECT, same command. A name may be a FILE or a DIRECTORY rather than a symbol. `resolve_name` already
// knew that and `locate_name` did not, so the two disagreed: on cal.com `handleNewBooking` is a directory of
// ~30 files, and `--locate handleNewBooking` found nothing. An agent orienting from a prose task very often
// holds a module name, not a symbol name.
//
// THE LINE THIS FILE DEFENDS: silence from this command is a claim ("it isn't here"), and a claim made from a
// truncated index is a lie. Better to be slow than confidently wrong.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadAddon } from "../../src/codebase/rust_core.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
const locate = (name: string): any[] => (loadAddon() as any).locateName(REPO, name, 50) ?? [];

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "locate-recall-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "lr", "version": "1.0.0" }`);
  // PAST THE OLD 4000-DEF CAP, on purpose. 90 files x 50 defs = 4500, so a symbol placed in the LAST file is
  // only reachable if the enumeration is genuinely uncapped. This is the smallest fixture that can fail on the
  // old code and pass on the new; a smaller one would pass either way and prove nothing.
  for (let f = 0; f < 90; f++) {
    const body = Array.from({ length: 50 }, (_, i) => `export function pad_${f}_${i}(): number { return ${i}; }`).join("\n");
    w(`src/bulk/file${String(f).padStart(3, "0")}.ts`, body + "\n");
  }
  // the needle, in the last-enumerated region
  w("src/zzz_last/DeepRepository.ts", `export class DeepRepository { find(): string { return "x"; } }\n`);
  // a DIRECTORY name that is not a symbol anywhere — the module-name case
  w("src/handleThing/stepOne.ts", `export const stepOne = () => 1;\n`);
  w("src/handleThing/stepTwo.ts", `export const stepTwo = () => 2;\n`);
});

afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

describe("--locate searches the WHOLE repo, not a truncated slice", () => {
  test("a symbol beyond the old 4000-def cap is found", () => {
    const rows = locate("DeepRepository");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].file).toContain("DeepRepository.ts");
    expect(rows[0].kind).toBe("class");
  });

  test("the fixture really is past the cap — otherwise this file proves nothing", () => {
    // Guards the guard. If the bulk generation were ever trimmed below the old limit, every assertion above
    // would pass on the broken code too, and this test would silently stop testing anything.
    // An EXPLICIT high limit: `enumerateDefs(repo, null, …)` itself defaults to 4000, so passing null here
    // would measure that default rather than the fixture, and this guard would be vacuous — it would report
    // "4000" forever regardless of how big the fixture got.
    const defs = (loadAddon() as any).enumerateDefs(REPO, 100000, null, false) ?? [];
    expect(defs.length).toBeGreaterThan(4000);
  });
});

describe("--locate resolves a MODULE name, not only a symbol name", () => {
  test("a directory name returns the defs it contains", () => {
    const rows = locate("handleThing");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.file).toContain("handleThing/");
    expect(rows.map((r: any) => r.symbol).sort()).toEqual(["stepOne", "stepTwo"]);
  });

  test("a name that is neither symbol nor path still returns nothing", () => {
    // The fallback must not become a fuzzy matcher that always finds SOMETHING. An honest empty is the whole
    // point of this command: it resolves addresses, it does not guess.
    expect(locate("definitelyNotAnythingHere")).toEqual([]);
  });
});
