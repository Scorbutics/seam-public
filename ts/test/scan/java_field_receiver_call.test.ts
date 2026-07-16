// Java field-receiver method call resolves to the receiver's DECLARED-TYPE method (a `call` edge), not just
// the type import — so the grow descends bean → repo → the data leaf. Before: `mBookingsBean.persist(b)` (a
// field of a CONCRETE in-repo class) resolved only the TYPE (BookingsBean) as an import; the invoked method +
// its body (the DB write it does) vanished with no blindspot, and the leaf read as unreachable — the "hub" was
// a red herring (the descent died at the import-not-call edge). _qualifiedCalleePass handled static-qualified
// (`Helper.doWork()`) and interface-typed receivers, but dropped a concrete-class field receiver. Offline
// (`--data-coupling floor`, SEAM_GRAPH_CACHE=0 so the fixture's committed .seam footprints don't mask it).
// Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(TS_DIR, "test", "fixtures", "booking-app");
const run = (args: string[]) =>
  spawnSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--data-coupling", "floor", ...args],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });

describe("Java concrete-class field-receiver call → method call edge (data-layer descent)", () => {
  test("a concrete-class field receiver resolves the METHOD (call edge), not just the type import", () => {
    if (!available()) return;   // needs tree-sitter
    // BookingsService.create body: `mBookingsBean.persist(b)` — mBookingsBean is a field of the concrete class BookingsBean.
    const deps = run(["--query", "dependencies", "--center", "ejb/BookingsService.java#create", "--format", "llm-context"]);
    expect(deps.stdout).toMatch(/persist \(ejb\/BookingsBean\.java:\d+\)\s+\[method, call\]/);
    // and the descent continues: BookingsBean.persist body `repo.save(b)` — repo is a field of the concrete class RecordRepo.
    const deps2 = run(["--query", "dependencies", "--center", "ejb/BookingsBean.java#persist", "--format", "llm-context"]);
    expect(deps2.stdout).toMatch(/save \(ejb\/RecordRepo\.java:\d+\)\s+\[method, call\]/);
  }, 60000);

  test("the grow descends through the field receivers to the repo leaf (RecordRepo)", () => {
    if (!available()) return;
    // Grow from the REST method → BookingsBean.persist → RecordRepo.save: the leaf is reachable ONLY via the
    // resolved field-receiver calls (the import/type-ref edges alone don't flood through).
    const grow = run(["--auto", "--max-steps", "40", "--intent", "create a booking", "--format", "agent",
      "--center", "ejb/BookingsService.java#create"]);
    expect(grow.stdout).toContain("RecordRepo");
  }, 60000);
});
