// `--locate` MUST OFFER ONLY ADDRESSES A CALLER CAN USE, AND SAY WHEN IT HAS NONE.
//
// THE MEASUREMENT (bench/grep-vs-seam, cal-booking-flow, 2026-08-01). Anchor hunting was the single largest
// block of the Seam arm's budget in all three runs — 3 of 8, 7 of 11, 9 of 20 calls — and every run began the
// same way: `--locate handleNewBooking`, then ls/find/denied-grep, looking for an entry point. Two defects in
// one output caused it.
//
// 1. HALF THE ROWS WERE NOT DEFINITIONS. `defs_in_file`'s DESCRIPTOR_KEY branch labels `name: {` — an
//    object-valued property — as kind `function`. Twelve of the 25 rows were prisma query fragments:
//    `reqBody`/`eventType` inside the type alias `CreateBookingParams`, `include`/`select`/`user` inside the
//    object literal `createBookingObj`, `connect` inside `BookingCreateInput`. `--center f.ts#include` resolves
//    to nothing, so those rows cost the reader attention and could never be acted on.
//
// 2. A MODULE MATCH WAS PRINTED AS A SYMBOL MATCH. `handleNewBooking` declares nothing — it is a directory of
//    ~30 files with no barrel. The command fell back to a path match (correctly) and then printed
//    "25 definition(s) — YOU choose which one answers your question", which reads as "one of these is what you
//    asked for". It is not, and no amount of reading the list reveals that. The engine knew and did not say.
//
// THE LINE THIS FILE DEFENDS: this command's whole contract is "here is an address you can pass to --center".
// A row that is not addressable violates it, and so does a list presented as an answer to a question it did not
// answer. The honest negative — "there is no way in, stop looking" — is the useful output here.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadAddon } from "../../src/codebase/rust_core.js";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const REPO = join(import.meta.dir, "..", "fixtures", "locate-repo");
const run = (name: string) => {
  const r = spawnSync("bun", [CLI, "--repo", REPO, "--locate", name], { encoding: "utf-8", timeout: 300_000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};
const rows = (name: string): any[] => (loadAddon() as any).locateName(REPO, name, 50) ?? [];

describe("object-valued properties are not offered as anchors", () => {
  test("the def table labels them `property`, not `function`", () => {
    // Asserting the LABEL at its source, because the kind is what every downstream filter keys on — and because
    // `function` here was not a display bug, it was a false claim about what the code is.
    const defs = ((loadAddon() as any).enumerateDefs(REPO, 100000, ["src/paymentFlow/charge.ts"], false) ?? []) as any[];
    const select = defs.find((d) => d.name === "select");
    expect(select).toBeTruthy();
    expect(select.kind).toBe("property");
    // and the real function in the same file is untouched
    expect(defs.find((d) => d.name === "charge")?.kind).toBe("function");
  });

  test("--locate does not list them", () => {
    // `select`, `include`, `id`, `amount`, `customer` all live inside `chargeQuery` and none is addressable.
    const names = rows("paymentFlow").map((r) => r.symbol);
    for (const junk of ["select", "include", "customer", "amount"]) expect(names).not.toContain(junk);
    // …while the genuine members survive. Without this the filter could pass by returning nothing at all.
    expect(names).toContain("charge");
    expect(names).toContain("refund");
  });

  test("they are KEPT in the def table for the embedding field", () => {
    // The fix is a relabel plus a locate-side filter, deliberately NOT a deletion: descriptor objects are how
    // route tables and config maps are written, and the field indexes named regions. Narrowing what the field
    // can see to tidy one command's output would be a silent trade of recall for neatness.
    const defs = ((loadAddon() as any).enumerateDefs(REPO, 100000, ["src/paymentFlow/charge.ts"], false) ?? []) as any[];
    expect(defs.map((d: any) => d.name)).toContain("select");
  });
});

describe("a MODULE match says so, and says whether there is a way in", () => {
  test("no barrel, no same-named symbol → it declares the dead end", () => {
    const out = run("paymentFlow");
    expect(out).toContain("is a MODULE");
    expect(out).toContain("NO ENTRY POINT");
    expect(out).toMatch(/Do NOT go looking for one/);
    // The old text claimed these WERE definitions of the name. That is the sentence that cost the calls.
    expect(out).not.toContain("YOU choose which one answers your question");
  });

  test("a barrel exists → it is ranked first and the dead-end banner is absent", () => {
    // The negative control for the banner: if "NO ENTRY POINT" appeared on every module match it would be
    // decoration, not information. `orderFlow/index.ts` is a real way in and must be treated differently.
    const out = run("orderFlow");
    expect(out).toContain("is a MODULE");
    expect(out).not.toContain("NO ENTRY POINT");
    expect(out).toContain("entry point(s) first");
    expect(rows("orderFlow")[0].file).toContain("orderFlow/index.ts");
  });

  test("a TOP-LEVEL directory matches too", () => {
    // The path fallback tested `/{base}/`, which a repo-relative top-level path never contains: `--locate
    // backend` answered "No definition of 'backend' found" for a directory that plainly exists. It survived
    // because the only module ever exercised was NESTED. Found by the snapshot case added for this branch, on
    // its first run — the reason that case exists rather than trusting a byte-identical diff.
    const out = run("orderFlow");           // nested, still works
    expect(out).toContain("is a MODULE");
    const r = spawnSync("bun", [CLI, "--repo", join(import.meta.dir, "..", "fixtures", "route-repo"), "--locate", "backend"],
      { encoding: "utf-8", timeout: 300_000 });
    expect(`${r.stdout}${r.stderr}`).toContain("is a MODULE");
  });

  test("a SYMBOL match is untouched by any of this", () => {
    // The regression guard. Symbol lookup is the command's main path and none of the above should reach it.
    const out = run("charge");
    expect(out).not.toContain("is a MODULE");
    expect(out).not.toContain("NO ENTRY POINT");
    expect(out).toContain("charge.ts#charge");
  });
});
