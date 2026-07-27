// REPO CONTENT EPOCH — the invalidation KEY every graph cache (footprint / coupling / grow / ubiquity) is keyed
// on. The contract that makes a warm run actually warm: a bare mtime TOUCH (an IDE reindex, a git checkout, a
// regenerated sibling) that leaves the bytes identical must NOT change the epoch — otherwise the whole cache goes
// MISS(stale) on unchanged files and the grow re-resolves from scratch (the "6-19s warm on a live checkout" bug).
// A REAL content edit must still bump it (else a stale answer survives — the alias / new-impl hole).
//
// Proven across SEPARATE PROCESSES (`bun -e`), because epochOf() memoizes per-process: an in-process second call
// returns the cached epoch and would hide the very re-computation we need to observe. Two fresh processes reload
// the persisted content-hash memo from `.seam` — exactly like two warm queries in the wild.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TS_DIR = join(import.meta.dir, "..", "..");
const FPC = join(TS_DIR, "src/codebase/footprint_cache.ts");
let repo: string;
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

// epochOf(repo) in its OWN process (graph cache on → the content-hash memo persists to .seam and is reused).
function epoch(): string {
  return execFileSync("bun", ["-e",
    `const {epochOf}=await import(${JSON.stringify(FPC)});console.log(epochOf(${JSON.stringify(repo)}))`],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

beforeEach(() => {
  repo = join(tmpdir(), "seam-epoch-" + process.pid + "-" + Math.round(process.hrtime()[1]));
  mkdirSync(repo, { recursive: true });
  w("package.json", `{ "name": "ep", "version": "1.0.0" }\n`);
  w("src/a.ts", `export const a = 1;\n`);
  w("src/b.ts", `export const b = 2;\n`);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("repo content epoch (content-hashed, mtime-robust)", () => {
  test("a bare mtime TOUCH (identical bytes) does NOT change the epoch", () => {
    const e1 = epoch();
    // move every source file's mtime far back, WITHOUT changing content or size — an IDE/git-style touch.
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(join(repo, "src/a.ts"), past, past);
    utimesSync(join(repo, "src/b.ts"), past, past);
    utimesSync(join(repo, "package.json"), past, past);
    const e2 = epoch();
    expect(e2).toBe(e1);   // THE FIX: content is byte-identical → epoch holds → the warm cache survives
    expect(e1).not.toBe("");
  });

  test("a real content EDIT still bumps the epoch", () => {
    const e1 = epoch();
    w("src/a.ts", `export const a = 999;\n`);   // same file, different bytes
    expect(epoch()).not.toBe(e1);               // change-detection is intact (no stale-hit hole)
  });

  test("a NEW source file bumps the epoch", () => {
    const e1 = epoch();
    w("src/c.ts", `export const c = 3;\n`);
    expect(epoch()).not.toBe(e1);
  });

  test("DELETING a source file bumps the epoch", () => {
    const e1 = epoch();
    rmSync(join(repo, "src/b.ts"));
    expect(epoch()).not.toBe(e1);
  });
});
