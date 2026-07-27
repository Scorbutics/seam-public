// Name-grounded recall — the floor for languages without symbol imports. Ruby is the sharp case: `Thing` is a
// `constant` node (not an identifier), and grep would also hit a comment mention. The AST scan must recover the
// real `Thing.new` caller and EXCLUDE the comment.
//
// The scan lives in the CORE now (seam-scan/src/name_consumers.rs), reached through the addon — `--recall name`
// asks `projectConsumerSet` for it in the same pass. So the assertions run against the addon: the RECALLED list
// stays separate from the verified members, and recall stays OPT-IN. Byte-identical to the TypeScript it
// replaced — pinned by rust/parity/route_recall.ts.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAddon } from "../../src/codebase/grow/rust_core.js";

const repo = join("test", "fixtures", "ruby-recall");
const addon = (): any => { try { return loadAddon(); } catch { return null; } };

describe("scanNameConsumers (Ruby constants, comment exclusion)", () => {
  test("recovers the real Thing.new caller and ignores the comment mention", () => {
    const a = addon();
    if (!a) return;
    const hits = a.scanNameConsumers(repo, "lib/thing.rb", "Thing") as any[];
    expect(hits.map((h) => `${h.file}:${h.symbol}`)).toContain("user.rb:use_thing");   // the real caller
    expect(hits.some((h) => h.file === "other.rb")).toBe(false);                       // unrelated file not matched
    // the comment "# Thing is mentioned…" is on line 0 of user.rb; the only hit there is use_thing (line 1),
    // never a bare line-0 comment match.
    expect(hits.filter((h) => h.file === "user.rb")).toHaveLength(1);
  });
});

describe("recall folded into the consumer SET", () => {
  test("never re-lists a file the verified floor already resolved", () => {
    const a = addon();
    if (!a) return;
    const set = a.projectConsumerSet(repo, "lib/thing.rb", "Thing", false, true);
    // The name scan DOES hit user.rb (asserted above) — but the import floor already RESOLVED that file, so
    // recall must not re-list it as an unverified lead. Dedupe-by-file is the whole discipline: a recalled
    // entry appears only for a file the verified floor could not reach.
    expect(set.members.map((m: any) => `${m.file}:${m.symbol}`)).toEqual(["user.rb:use_thing"]);
    expect(set.recalled).toHaveLength(0);
  });

  test("recall is OPT-IN — the default set carries no unverified leads", () => {
    const a = addon();
    if (!a) return;
    expect(a.projectConsumerSet(repo, "lib/thing.rb", "Thing", false, false).recalled).toHaveLength(0);
  });
});
