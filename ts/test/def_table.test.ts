// def_table: enumerate top-level defs + class methods with enclosing class, for embedding recall.
import { describe, expect, test } from "bun:test";
import { defs_in_file, embedString } from "../src/codebase/def_table.js";

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
