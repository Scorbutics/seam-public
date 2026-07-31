// AN ERROR THAT CAN NAME THE FIX MUST NAME IT — measured, not stylistic.
//
// THE MEASUREMENT (bench/grep-vs-seam, case cal-ab3, 2026-07-31). A Seam-only agent spent 32 tool calls on a
// question whose ANALYSIS was 4 calls. Reading every call, the budget went to: 10 hunting for the anchor, 6
// re-reading two files it had already read, ~10 flailing with awk — and TWO on errors it could not act on:
//
//   --center "…/RegularBookingService.ts#RegularBookingService.createBooking"
//     -> "'RegularBookingService.createBooking' is not declared in …"
//   --query dependencies --center "…/BookingRepository.ts"
//     -> "requires a SYMBOL: --center <file>#<symbol>"
//
// Both are TRUE and both are useless. The first already printed a candidate list containing `createBooking`;
// it just never connected the dotted form to it, and `Class.method` is how most languages and most humans name
// a method, so it is a predictable miss. The second told an agent to supply a symbol it did not know — which
// is precisely why it had passed the file. Each cost a full round trip, and after the second the agent gave up
// on Seam and fell back to awk.
//
// THE LINE THIS FILE DEFENDS: when the engine already holds the information that would fix the caller's
// command, it must print that information. Asserting on the TEXT is the point — a non-zero exit with a correct
// but unusable message is the failure being tested, and it would pass any assertion about the exit code.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const REPO = join(import.meta.dir, "..", "fixtures", "booking-app");
const run = (args: string[]) => {
  const r = spawnSync("bun", [CLI, ...args], { encoding: "utf-8", timeout: 300_000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

describe("a dotted Class.method anchor is told the addressable form", () => {
  test("it suggests the bare method name it already knows about", () => {
    const out = run(["--repo", REPO, "--scan", "--query", "contract",
      "--center", "ejb/BookingsBean.java#BookingsBean.persist"]);
    expect(out).toContain("DID YOU MEAN");
    expect(out).toContain("#persist");     // the addressable form, spelled out ready to paste
  });

  test("it explains WHY, so the caller learns the addressing rule", () => {
    const out = run(["--repo", REPO, "--scan", "--query", "contract",
      "--center", "ejb/BookingsBean.java#BookingsBean.persist"]);
    expect(out).toMatch(/method is addressed by its OWN name/i);
  });

  test("a non-JS file is not told about DEFAULT EXPORTS it cannot have", () => {
    // This branch fired on a Java fixture and advised `--center "Foo.java#undefined"` — wrong twice (Java has
    // no default exports; nothing declares a symbol called `undefined`) and it costs the round trip the error
    // exists to save. A hint that can be wrong must be guarded, not merely worded carefully.
    const out = run(["--repo", REPO, "--scan", "--query", "contract",
      "--center", "ejb/BookingsBean.java#BookingsBean.persist"]);
    expect(out).not.toContain("#undefined");
    expect(out).not.toMatch(/DEFAULT export is the local symbol 'undefined'/);
  });

  test("a genuinely unknown symbol does NOT get a fabricated suggestion", () => {
    // The suggestion fires only when the last dotted segment is a REAL candidate. Guessing would be worse than
    // silence: a confident wrong `--center` costs another round trip and erodes trust in every other hint.
    const out = run(["--repo", REPO, "--scan", "--query", "contract",
      "--center", "ejb/BookingsBean.java#Nope.alsoNope"]);
    expect(out).not.toContain("DID YOU MEAN");
    expect(out).toContain("addressable symbols here");   // the honest fallback: here is what DOES exist
  });
});

describe("a file anchor on a symbol-scoped shape is told the file's symbols", () => {
  for (const q of ["dependencies", "consumers"]) {
    test(`--query ${q} on a bare file enumerates what it could have meant`, () => {
      const out = run(["--repo", REPO, "--scan", "--query", q, "--center", "ejb/BookingsBean.java"]);
      expect(out).toContain("requires a SYMBOL");        // still an error — the shape IS symbol-scoped
      expect(out).toContain("symbols in");               // …but it no longer stops there
      expect(out).toContain("BookingsBean");             // the actual answer space
    });
  }

  test("it points at --locate for the cross-repo case", () => {
    // The agent's real problem was "I don't know the symbol". Naming the command that answers that, at the
    // moment the caller is stuck, is the cheapest possible routing.
    const out = run(["--repo", REPO, "--scan", "--query", "dependencies", "--center", "ejb/BookingsBean.java"]);
    expect(out).toContain("--locate");
  });
});
