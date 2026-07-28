// The "member" matcher IR shape — `<token>.<KEY>.<verb>(…)`, the dominant ORM/repository data-access shape
// (prisma.eventType.findMany / db.user.update / a project's own repo.<entity>.save). It lets the flywheel
// FACTOR a whole receiver-member layer into ONE rule-pair (read/write) instead of an LLM call per file —
// validated on cal.com: 2 Prisma files learned the pair, which then covered 9/9 footprint Prisma files.
import { describe, expect, test } from "bun:test";
import { validateMatcher, runMatcher, type KeyMatcher } from "../helpers/coupling.js";

describe("member matcher shape (receiver-member data-access layer)", () => {
  const read = validateMatcher({ via: "member", token: "prisma", verbs: ["findUnique", "findMany", "count"], kind: "db-table", role: "consumes" });
  const write = validateMatcher({ via: "member", token: "prisma", verbs: ["create", "update", "delete"], kind: "db-table", role: "produces" });

  test("validates: bare token + ≥1 verb; rejects a metachar token or empty verbs", () => {
    expect(read?.via).toBe("member");
    expect((read as any).token).toBe("prisma");
    expect(validateMatcher({ via: "member", token: "pri.sma", verbs: ["find"], kind: "db-table", role: "consumes" })).toBeNull();   // dotted token → no injection
    expect(validateMatcher({ via: "member", token: "prisma", verbs: [], kind: "db-table", role: "consumes" })).toBeNull();         // no verb → would match any member
  });

  test("extracts the MEMBER as the key, with role from the verb set", async () => {
    const code = `
      const e = await prisma.eventType.findUnique({ where });
      await prisma.user.update({ data });
      const t = await prisma.team.findMany();
      await prisma.booking.delete({ where });
      this.other.thing.run();   // different receiver → ignored
    `;
    const r = (await runMatcher(read!, "x.ts", code)).map((h) => `${h.value}:${h.produces ? "P" : "C"}`).sort();
    const w = (await runMatcher(write!, "x.ts", code)).map((h) => `${h.value}:${h.produces ? "P" : "C"}`).sort();
    expect(r).toEqual(["eventType:C", "team:C"]);     // read verbs → consumes
    expect(w).toEqual(["booking:P", "user:P"]);       // write verbs → produces
  });

  test("the same rule works for a PROJECT-SPECIFIC layer token (not just prisma)", async () => {
    const m = validateMatcher({ via: "member", token: "repo", verbs: ["save", "load"], kind: "db-table", role: "produces" });
    const keys = (await runMatcher(m!, "x.ts", "repo.booking.save(b); repo.member.load(id);")).map((h) => h.value).sort();
    expect(keys).toEqual(["booking", "member"]);       // generic — learns whatever receiver the project uses
  });
});
