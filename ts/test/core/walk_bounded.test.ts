// walkFiles size-bounded reading (#4 "stream, don't fully load"): a file larger than opts.maxBytes is
// STAT-skipped before it's ever read into a string — the memory-safe path so a multi-MB generated/minified
// bundle on a huge repo can't blow the heap. onSkip reports what was dropped (for the floor-index diagnostic).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walkFiles } from "../../src/core/resolve/walk.js";

const REPO = join(tmpdir(), "seam-walk-bounded-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  write("small.js", 'const q = "ok";');
  write("huge.js", "x".repeat(2_000_000));   // 2 MB → over a 1 MB cap
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("walkFiles maxBytes / onSkip", () => {
  const all = (rel: string) => rel.endsWith(".js");
  test("no cap → both files are read", () => {
    const rels = [...walkFiles(REPO, new Set([".git"]), all)].map((f) => f.rel).sort();
    expect(rels).toEqual(["huge.js", "small.js"]);
  });
  test("with a 1 MB cap → the oversized file is stat-skipped (never read) and reported via onSkip", () => {
    const skipped: { rel: string; bytes: number }[] = [];
    const got = [...walkFiles(REPO, new Set([".git"]), all, { maxBytes: 1_000_000, onSkip: (rel, bytes) => skipped.push({ rel, bytes }) })];
    expect(got.map((f) => f.rel)).toEqual(["small.js"]);            // only the small file yielded
    expect(skipped.map((s) => s.rel)).toEqual(["huge.js"]);        // the big one reported, not yielded
    expect(skipped[0].bytes).toBeGreaterThan(1_000_000);
  });
  test("maxBytes:0 disables the cap", () => {
    const rels = [...walkFiles(REPO, new Set([".git"]), all, { maxBytes: 0 })].map((f) => f.rel).sort();
    expect(rels).toEqual(["huge.js", "small.js"]);
  });
});
