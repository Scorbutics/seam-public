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
import { readFileSync } from "node:fs";
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

describe("a definition is an ADDRESS, and a partial answer says so", () => {
  test("every row cites file:line, not just file#symbol", () => {
    // Without the line, a caller told WHERE a symbol lives must still open the file and search for it. Measured
    // on keycloak: seven paging reads of a 1,449-line Java file, after Seam had already named it.
    const out = run("charge");
    expect(out).toMatch(/charge\.ts:\d+#charge/);
  });

  test("the cited line is the DECLARATION, verified against the source", () => {
    // Asserting the line NUMBER, not merely that one exists. A citation that resolves to the wrong line is
    // worse than none: it sends the reader somewhere confidently. `charge` is declared on line 2 of the fixture
    // (line 1 is the module comment).
    const r = rows("charge")[0];
    const src = readFileSync(join(REPO, r.file), "utf-8").split("\n");
    expect(src[r.line - 1]).toContain("export function charge");
  });

  test("a truncated answer DECLARES the cut and names the narrowing flag", () => {
    // `--locate getRealm` on keycloak has 206 definitions, shows 25, and the wanted one ranks 167th. Printing
    // "25 definition(s)" for that is silently partial and reads as complete — the agent's only recourse is to
    // guess another name, which is what the transcripts show.
    // The fixture is small, so this asserts the HONEST side: when everything is shown, no cut is claimed.
    // The truncated side is exercised directly against the core below, where a limit can be forced — a
    // fixture big enough to overflow 25 would be slower and would test the same branch.
    expect(run("charge")).not.toContain("NOT all of them");
    // …and the TRUNCATED side, forced with limit=1 against a name that has two definitions. Asserting only the
    // honest side left this case passing with `total` deliberately clamped to the limit — i.e. with the whole
    // point of the field removed. Caught in the falsification run; the honest side alone is not a test.
    const g: any[] = (loadAddon() as any).locateNames(REPO, "orderFlow", 1, undefined) ?? [];
    expect(g[0].rows.length).toBe(1);
    expect(g[0].total).toBeGreaterThan(1);
  });

  test("--in narrows the corpus, and an empty result says where it looked", () => {
    const out = spawnSync("bun", [CLI, "--repo", REPO, "--locate", "charge", "--in", "src/orderFlow"],
      { encoding: "utf-8", timeout: 300_000 });
    const text = `${out.stdout}${out.stderr}`;
    expect(text).toContain("No definition of 'charge' found");
    expect(text).toContain("under 'src/orderFlow'");   // not a bare "not found" — WHERE it looked
  });
});

describe("a BATCH of names is one call, and names its misses", () => {
  // MEASURED (bench/grep-vs-seam, keycloak, 2026-08-01). Anchor hunting dominated the Seam arm, and the call
  // count understated it: 12, 16 and 8 Bash calls carried 19, 23 and 10 `--locate` INVOCATIONS, because agents
  // were already chaining `--locate A; echo ===; --locate B` in a single shell command. They wanted a batch.
  //
  // Worse, the natural spelling was a FALSE NEGATIVE, not merely unsupported: `--locate "A,B"` looked up the
  // literal string `A,B` and printed "No definition of 'A,B' found ... grep is the right next step" for two
  // symbols that both exist. That is the one failure this command must not have (see locate_recall.test.ts),
  // reached through a spelling nobody had tested.
  test("comma-separated names each get their own answer", () => {
    const out = run("charge,refund");
    expect(out).toMatch(/charge\.ts:\d+#charge/);
    expect(out).toMatch(/refund\.ts:\d+#refund/);
    // NOT the old false negative
    expect(out).not.toContain("No definition of 'charge,refund'");
  });

  test("a name that misses is NAMED, not silently dropped", () => {
    // Which of the batch came back empty is precisely what a batch lookup is asked, and a flat merged list
    // cannot say it — hence the grouped result. A batch that quietly returns only the hits would let a caller
    // believe a symbol exists somewhere in the noise.
    const out = run("charge,definitelyNotAnythingHere");
    expect(out).toMatch(/charge\.ts:\d+#charge/);
    expect(out).toMatch(/definitelyNotAnythingHere — no definition found/);
    expect(out).toContain("1 resolved, 1 not found");
  });

  test("whitespace around names is tolerated", () => {
    // Agents write `--locate "A, B"`. Failing on the space would reproduce the false negative in a new spelling.
    const out = run("charge, refund");
    expect(out).toMatch(/charge\.ts:\d+#charge/);
    expect(out).toMatch(/refund\.ts:\d+#refund/);
  });

  test("a single name is unchanged — the batched path must not capture it", () => {
    const out = run("charge");
    expect(out).not.toContain("name(s)");
    expect(out).toMatch(/charge\.ts:\d+#charge/);
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
    expect(out).toMatch(/charge\.ts:\d+#charge/);
  });
});
