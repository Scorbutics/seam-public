// BARREL RE-EXPORTS — the last correctness gap the tsc oracle sweep could see, and it was three defects wearing
// one coat.
//
// Found by `bench/oracle`, not by a test. On private-app the contract claimed 6 call sites for
// `mapTasksToReceivedMissions` where tsc proved 8, and 15 for `computeWeekAnchor` where tsc proved 19:
//
//   1. NAMED BARREL. `lib/services/missions.ts` does nothing but
//      `export { mapTasksToReceivedMissions } from "@/lib/utils/missions"`, and
//      `app/api/missions/received/route.ts` imports it from THERE and calls it twice. The module-anchored
//      reverse-import scan matched an import only when its source resolved DIRECTLY to the anchor, so every
//      consumer behind a barrel was dropped — from the contract, from `afferent`, and from the module footprint
//      every module-anchored shape is built on. The SYMBOL-anchored path had followed barrels all along, so the
//      two paths disagreed about the same repo.
//   2. RENAMING BARREL. `components/admin/utils.tsx` forwards `computeWeekAnchor` as
//      `getWeekStartForPreference`, and `app/dashboard/actions/page.tsx` calls THAT name four times. Following
//      the hop put the file in the consumer list, but the call-site count grepped the parse for the EXPORT name
//      and found nothing. A barrel exists precisely so callers can spell a name differently.
//   3. STAR BARREL. `export * from "m"` names nothing, so it could not be represented as an import ref at all
//      and was invisible. private-app has none; cal.com has 343, one per package `index.ts`.
//
// The fixture is built so each mechanism is the ONLY way to reach its count: drop any hop and a number falls.
import { describe, expect, test, beforeAll } from "bun:test";
import { projectContract } from "../helpers/shapes.js";

// THE FIXTURE IS ON DISK (`test/fixtures/barrel-repo`) and not built here, so the CLI snapshot gate runs the
// same tree: the gate had NO barrel case at all, which is why it showed zero diffs for a fix that moved real
// counts on private-app. Its README documents what each file is for.
const REPO = "test/fixtures/barrel-repo";
let contract: any;
const got = (sym: string) => contract.provides.find((p: any) => p.symbol === sym);
const files = (sym: string) => (got(sym)?.consumers ?? []).map((x: any) => x.file).sort();

beforeAll(async () => { contract = await projectContract(REPO, "src/decl.ts"); });

describe("the module contract follows barrel re-exports", () => {
  test("a consumer behind one named barrel is a consumer", () => {
    expect(files("mapTasks")).toContain("src/route.ts");
  });

  test("the hop is transitive, not one level", () => {
    // facade.ts re-exports from service.ts, which re-exports from the anchor.
    expect(files("mapTasks")).toContain("src/deep.ts");
  });

  test("a consumer behind a STAR barrel is a consumer", () => {
    expect(files("mapTasks")).toContain("src/starcons.ts");
  });

  test("`export * as ns from` is NOT followed — it binds a namespace, not the names", () => {
    // It re-exports a NAME for the module, so its members are reached as `ns.member` and never as bare names.
    // Following it as a transparent forward would invent bindings no caller can write.
    expect(files("mapTasks")).not.toContain("src/nsstar.ts");
  });

  test("a NAMED barrel is a consumer; a STAR barrel is only a hop", () => {
    // Both are pure forwarders, so listing both was tried — and the unused-export test below killed it. A named
    // re-export is evidence about ONE symbol (somebody wrote that name deliberately); `export *` is evidence
    // about none, because it forwards whatever happens to be there. Counting it made `unusedByAnyone` look
    // consumed, which on cal.com's 343 star barrels would empty the dead-public-API signal everywhere.
    expect(files("mapTasks")).toContain("src/service.ts");
    expect(files("mapTasks")).not.toContain("src/star.ts");
    // ...and the hop still works: the file BEHIND the star barrel is reached (asserted above).
    expect(files("mapTasks")).toContain("src/starcons.ts");
  });

  test("every barrel-reached call site is in the observed count", () => {
    const m = got("mapTasks");
    // route 2 + deep 1 + starcons 1 + both 2 (the direct call AND the aliased one) = 6.
    // Before the fix this was 1: only both.ts imported the anchor directly, and only under its own name.
    expect(m.observed.callSites).toBe(6);
    expect(m.observed.arity).toEqual([[2, 6]]);
  });

  test("a file reached both directly AND through a barrel is ONE consumer, not two", () => {
    const m = got("mapTasks");
    expect(m.consumers.filter((x: any) => x.file === "src/both.ts").length).toBe(1);
    // and the file-grained count agrees with the distinct files listed
    expect(m.consumerCount).toBe(new Set(m.consumers.map((x: any) => x.file)).size);
  });

  test("call sites are counted by the name the CONSUMER spells, not the export name", () => {
    const r = got("renamedOnly");
    // `renamedAway(…)` × 3, attributed back to the export it binds. Counting by the export name found 0 of them.
    expect(r.observed.callSites).toBe(3);
    expect(files("renamedOnly")).toContain("src/renamed.ts");
  });

  test("an export nobody imports through any barrel stays unused", () => {
    // FALSIFICATION of the walk: following barrels must not turn every export into a consumed one. If a hop
    // over-reached — attributing a barrel's whole name set to every member — this would go green-and-wrong.
    expect(contract.unusedExports.map((u: any) => u.symbol)).toContain("unusedByAnyone");
    expect(got("unusedByAnyone")).toBeUndefined();
  });
});
