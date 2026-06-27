// The grow seeds the anchor's full SURROUNDINGS — UP (consumers) AND DOWN (direct deps) — from the single
// anchor, because an intent is a multi-call graph, not a one-way climb. The old type-tree-explosion risk
// (Java same-package turns every referenced type into a "dependency" → BookingData → MemberBooking → User) is
// held in check NOT by refusing to descend, but by demoting payload type-refs in the frontier (B): the DIRECT
// deps appear, the TRANSITIVE data-model tree is not chased. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "seed-dir-"));
  // mid-spine method: createBooking is CALLED by a resource (consumer, up) and references a data-model chain (down).
  w("src/BookingBean.java", `package a;\npublic class BookingBean { public Booking createBooking(User u){ BookingData d = new BookingData(u); return repo.save(d); } }\n`);
  w("src/BookingData.java", `package a;\npublic class BookingData { MemberBooking member; public BookingData(User u){} }\n`);
  w("src/MemberBooking.java", `package a;\npublic class MemberBooking { User user; }\n`);
  w("src/User.java", `package a;\npublic class User { String name; }\n`);
  w("src/BookingsResource.java", `package a;\npublic class BookingsResource { BookingBean b; public Booking create(User u){ return b.createBooking(u); } }\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const files = async (opts: any): Promise<string[]> => {
  const [data] = await grow_to_terminals(REPO, "src/BookingBean.java", "createBooking", { maxSteps: 6, ...opts });
  return data.nodes.filter((n: any) => n.id !== "n1").map((n: any) => n.file as string);
};

describe("grow seed: explore the anchor's full surroundings (up + down), without chasing the type tree", () => {
  test("a mid-spine anchor climbs to its consumer AND descends to its direct deps", async () => {
    if (!available()) return;
    const f = await files({});
    expect(f).toContain("src/BookingsResource.java");        // UP — climbed to the consumer
    expect(f).toContain("src/BookingData.java");             // DOWN — its direct dependency is now seeded
  });

  test("the TRANSITIVE data-model tree is still not chased (payload type-refs demoted, B)", async () => {
    if (!available()) return;
    const f = await files({});
    // MemberBooking is a dep of BookingData (a payload) — the frontier does NOT descend the transitive tree.
    expect(f).not.toContain("src/MemberBooking.java");
  });
});
