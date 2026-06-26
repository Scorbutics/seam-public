// The grow SEEDS UP (consumers) and only descends into DEPS for a true entry point. A mid-spine method anchor
// (one WITH in-repo consumers) must NOT descend into its data-model type tree — Java's same-package resolution
// turns every referenced type into a "dependency", so an unguarded down-seed gets lost
// `BookingBean → BookingData → MemberBooking → User`. Assert it climbs to the consumer and does not descend.
// `--bidirectional` (opts.bidirectional) restores the deps. Guards on tree-sitter.
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

describe("grow seed: climb up by default, descend only for entry points", () => {
  test("a mid-spine anchor climbs to its consumer and does NOT descend the data-model tree", async () => {
    if (!available()) return;
    const f = await files({});
    expect(f).toContain("src/BookingsResource.java");        // climbed to the consumer
    expect(f).not.toContain("src/MemberBooking.java");       // did NOT descend the type tree
    expect(f).not.toContain("src/User.java");
  });

  test("--bidirectional restores the deps (down) for those who want both", async () => {
    if (!available()) return;
    const f = await files({ bidirectional: true });
    expect(f).toContain("src/BookingData.java");             // the direct dep is back
  });
});
