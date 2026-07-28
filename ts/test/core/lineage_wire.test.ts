// GIT LINEAGE across the napi boundary. The lineage itself — which commit last touched a file, and the
// degrade-to-nothing contract off a repo — is asserted in Rust next to the implementation (`seam-fs`), where
// a real git repo can be built in a temp dir and the actual sha/subject/author checked hermetically.
//
// What is asserted HERE is the only part those tests cannot see: the WIRE. The core returns flat
// `[file, sha, subject, author, date]` rows because napi cannot carry a Map, and `emit_seams` rehydrates them
// into the `{sha, subject, author, date}` object each seam publishes. A field reordered on either side would
// keep every Rust test green while shipping the author as the subject.
import { describe, expect, test } from "bun:test";
import { loadAddon } from "../../src/codebase/rust_core.js";

const addon = loadAddon();

describe("git lineage — the napi row shape emit_seams rehydrates", () => {
  test("a tracked file yields one 5-field row, positionally as emit_seams reads it", () => {
    if (!addon) return;
    // this repo, and a file it certainly tracks
    const rows = addon.gitLineage(".", ["package.json"]) as string[][];
    if (!rows.length) return;   // not a git checkout (a packaged install) → nothing to assert
    expect(rows.length).toBe(1);
    const [file, sha, subject, author, date] = rows[0];
    expect(file).toBe("package.json");
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);           // short sha, not a subject in the sha slot
    expect(subject.length).toBeGreaterThan(0);
    expect(author.length).toBeGreaterThan(0);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);     // %as — the field that pins the ORDER of the last three
  });

  test("an unresolvable file is ABSENT from the rows, not present-and-blank", () => {
    if (!addon) return;
    // absent is what the caller wants: `emit_seams` attaches nothing, so a seam shows no provenance rather
    // than an empty provenance line claiming git knew something.
    const rows = addon.gitLineage(".", ["no/such/file/zzz.ts"]) as string[][];
    expect(rows.length).toBe(0);
  });
});
