// The FRAMEWORK-AGNOSTIC member-access floor adapter: `<recv>.<member>.<verb>()` with a DISTINCTIVE ORM
// verb → the member is a db-table key, role from the verb. This is what lets the dominant ORM-coupling
// shape ground COLD/deterministically (no LLM flywheel). Validated on cal.com (100% recall of the LLM
// member:prisma rule + 15 real models it missed); these tests pin the structural contract: any receiver
// matches, the 3-part chain + distinctive-verb guards keep precision, and it's wired into the floor scan.
import { describe, expect, test } from "bun:test";
import { adapterKeys, scan_file_keys } from "../helpers/coupling.js";


const keys = (text: string) => adapterKeys("member-access", "x.ts", text).map((h) => `${h.value}:${h.produces ? "P" : "C"}`).sort();

describe("member-access adapter — framework-agnostic ORM coupling", () => {
  test("ANY receiver matches; the member is the table, the verb gives the role", () => {
    expect(keys(`prisma.booking.create({});`)).toEqual(["booking:P"]);          // Prisma
    expect(keys(`db.user.findMany();`)).toEqual(["user:C"]);                     // a `db` client
    expect(keys(`tx.payment.upsert({});`)).toEqual(["payment:P"]);              // a transaction
    expect(keys(`myRepo.invoice.updateMany({});`)).toEqual(["invoice:P"]);      // a project's OWN repo — no framework name
    // mid-path: this.dbRead.account.findUnique() → receiver `dbRead`, member `account`
    expect(keys(`const a = this.dbRead.account.findUnique({ where });`)).toEqual(["account:C"]);
  });

  test("read vs write role from the verb set", () => {
    expect(keys(`prisma.team.findFirst(); prisma.team.deleteMany();`)).toEqual(["team:C", "team:P"]);
  });

  test("PRECISION guards: no 2-part generic calls, no generic verbs, no self-receiver, no comments", () => {
    expect(keys(`arr.find(x => x);`)).toEqual([]);            // 2-part, no member
    expect(keys(`map.delete(k);`)).toEqual([]);              // 2-part
    expect(keys(`svc.thing.get();`)).toEqual([]);            // generic verb `get` excluded
    expect(keys(`obj.list.add(item);`)).toEqual([]);         // generic verb `add` excluded
    expect(keys(`this.user.findMany();`)).toEqual([]);       // self-receiver → the receiver is a path, not a data object
    expect(keys(`// prisma.booking.create();`)).toEqual([]); // inside a comment → masked
  });

  test("wired into the floor scan (scan_file_keys surfaces it with no LLM)", () => {
    const hits = scan_file_keys("svc.ts", `export const f = () => prisma.eventType.findMany();`);
    expect(hits.some((h) => h.kind === "db-table" && h.value === "eventType" && !h.produces)).toBe(true);
  });
});
