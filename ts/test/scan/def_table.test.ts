// def_table: enumerate top-level defs + class methods with enclosing class, for embedding recall.
import { describe, expect, test } from "bun:test";
import { defs_in_file, embedString } from "../../src/codebase/scan/def_table.js";

const SRC = `
export class SupabaseWeeklyTaskRepository {
  async save(task: WeeklyTask): Promise<void> { /* … */ }
  getByMemberAndWeek(memberId: string, week: number) { return null; }
}
export function generateMemberMissions() { return []; }
const formatDate = (d: Date): string => d.toISOString();
`;

describe("def_table enumeration", () => {
  const defs = defs_in_file("scoring-cycle/repositories.ts", SRC);
  const by = (n: string) => defs.find((d) => d.name === n);

  test("captures classes, functions, const-arrows, and methods", () => {
    expect(by("SupabaseWeeklyTaskRepository")?.kind).toBe("class");
    expect(by("generateMemberMissions")?.kind).toBe("function");
    expect(by("formatDate")?.kind).toBe("function");
    expect(by("save")?.kind).toBe("method");
  });

  test("a method carries its enclosing class (the domain signal the bare name lacks)", () => {
    expect(by("save")?.enclosing).toBe("SupabaseWeeklyTaskRepository");
    expect(embedString(by("save")!)).toContain("in SupabaseWeeklyTaskRepository");
    expect(embedString(by("save")!)).toContain("scoring-cycle/repositories.ts");
    // a control-flow keyword inside a method body is NOT mistaken for a method def
    expect(by("if")).toBeUndefined();
  });
});

// BODY passage — the calls/identifiers AROUND a callable (the concept the signature+doc omit). Callables
// only; bounded; brace-only/comment/blank lines skipped. This is what answers "are you using the passage
// around each symbol" for the embedding ranking.
describe("def_table body passage (callables only, bounded)", () => {
  const SRC2 = `
export function memberBookings(adviserId) {
  // fetch the adviser's bookings
  const rows = bookingRepository.findByAdviser(adviserId);
  return rows.map(mapBookingToDto);
}
export class Role {
  ADMINISTRATOR;
}
`;
  const defs = defs_in_file("svc/bookings.ts", SRC2);
  const by = (n: string) => defs.find((d) => d.name === n);

  test("a callable embeds the calls in its body (the salient 'what it does')", () => {
    const e = embedString(by("memberBookings")!);
    expect(e).toContain("bookingRepository.findByAdviser");
    expect(e).toContain("mapBookingToDto");
  });
  test("body is brace/comment-free and bounded (no lone `}`, no doc-comment line)", () => {
    const b = by("memberBookings")!.body!;
    expect(b).not.toMatch(/^[{}]|[{}]$/);            // no leading/trailing brace
    expect(b).not.toContain("fetch the adviser");    // comment line skipped
    expect(b.length).toBeLessThanOrEqual(240);       // SCAN.bodyCap
  });
  test("a CONTAINER (class/enum) has NO body — its members are relevance noise", () => {
    expect(by("Role")?.kind).toBe("class");
    expect(by("Role")?.body).toBeUndefined();
  });
});

// enumerate_defs `files` filter — the footprint-scoped embedding lever (#3). annotateIntentRelevance only
// needs the seams' OWN files, so we embed just those, not a whole-repo tree-sitter walk. The emitted
// Def.file stays the canonical rel (we FILTER candidate_source_files), so cache keys match the unscoped pass.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enumerate_defs } from "../../src/codebase/scan/def_table.js";

describe("enumerate_defs files-scope", () => {
  const repo = mkdtempSync(join(tmpdir(), "seam-defscope-"));
  writeFileSync(join(repo, "alpha.ts"), "export function alpha() { return 1; }\n");
  writeFileSync(join(repo, "beta.ts"), "export function beta() { return 2; }\n");

  test("no files arg → all files' defs", async () => {
    const names = (await enumerate_defs(repo)).map((d) => d.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    rmSync(repo, { recursive: true, force: true });
  });
  test("files set → only those files' defs, with the canonical rel preserved", async () => {
    const repo2 = mkdtempSync(join(tmpdir(), "seam-defscope2-"));
    writeFileSync(join(repo2, "alpha.ts"), "export function alpha() { return 1; }\n");
    writeFileSync(join(repo2, "beta.ts"), "export function beta() { return 2; }\n");
    const scoped = await enumerate_defs(repo2, 4000, new Set(["alpha.ts"]));
    expect(scoped.map((d) => d.name)).toEqual(["alpha"]);
    expect(scoped[0].file).toBe("alpha.ts");   // canonical rel (cache parity with the unscoped recall pass)
    rmSync(repo2, { recursive: true, force: true });
  });
});

// The whole-repo def LIMIT truncates ALPHABETICALLY — the monorepo recall trap: a module sorted late
// (web-acmecheck after web-manage) is cut off and never becomes an anchor candidate. The limit is the
// knob (SEAM_DEF_LIMIT in embedScoreDefs) — raising it recovers the late module.
describe("enumerate_defs limit truncates alphabetically (the SEAM_DEF_LIMIT trap)", () => {
  const repo = mkdtempSync(join(tmpdir(), "seam-deflimit-"));
  // sorts first, fills the budget:
  writeFileSync(join(repo, "web-manage.ts"), "export function m1(){}\nexport function m2(){}\nexport function m3(){}\n");
  // sorts LATE — the symbol the user expects:
  writeFileSync(join(repo, "web-acmecheck.ts"), "export function bookingService(){}\n");

  test("a low limit drops the late-sorted module's symbol", async () => {
    const names = (await enumerate_defs(repo, 3)).map((d) => d.name);
    expect(names).not.toContain("bookingService");   // cut off — exactly the reported failure
  });
  test("raising the limit recalls it", async () => {
    const names = (await enumerate_defs(repo, 100)).map((d) => d.name);
    expect(names).toContain("bookingService");
    rmSync(repo, { recursive: true, force: true });
  });
});
