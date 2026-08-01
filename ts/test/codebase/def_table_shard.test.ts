// THE DEF-TABLE DISK SHARD — warm reuse must be IDENTICAL, and an edit must invalidate it.
//
// WHY IT EXISTS (measured 2026-08-01, keycloak). `--locate` enumerates the whole repo — deliberately uncapped,
// since the old 4000-def cap produced false negatives — and the memo was process-local, so every CLI invocation
// re-did the full scan: 7.2s a call, and a benchmark agent issued 10-12 per run, i.e. 80-96s of a 104-218s
// engine budget in a case Seam lost to grep 34 calls to 22.
//
// It is the LANGUAGE MIX, not repo size: Java goes through tree-sitter at 0.79 ms/file, TS/JS through the regex
// extractor at 0.10 ms/file. keycloak is 8141 Java files; cal.com is zero. `def_table` was the only index of
// eleven without a disk shard.
//
// WHAT MAKES A DEF CACHE DANGEROUS, and why this file is not optional: the def table is the address book. A
// stale one does not degrade an answer, it relocates symbols — `--locate` points at a line that has moved, and
// every shape anchored through it inherits the error silently. The shared content epoch is what prevents that,
// and this asserts it rather than trusting it.
//
// REAL CLI SUBPROCESSES, like footprint_cache.test.ts and for the same reason: the warm scenario IS a fresh
// process per query. An in-process second call would hit the in-memory memo and prove nothing about the disk
// layer — the very thing under test.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
let repo: string;
const w = (rel: string, t: string) => { mkdirSync(join(repo, rel, ".."), { recursive: true }); writeFileSync(join(repo, rel), t); };
const locate = (name: string): string =>
  execFileSync("bun", [CLI, "--repo", repo, "--locate", name], { encoding: "utf-8", timeout: 300_000 });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "def-shard-"));
  writeFileSync(join(repo, "package.json"), `{ "name": "ds", "version": "1.0.0" }`);
  w("src/alpha.ts", `export function alpha() { return 1; }\n`);
  w("src/beta.ts", `export class Beta { run() { return 2; } }\n`);
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("warm reuse is transparent", () => {
  test("a second PROCESS gets a byte-identical answer, and the shard is on disk", () => {
    const cold = locate("Beta");
    const warm = locate("Beta");
    expect(warm).toBe(cold);
    expect(warm).toContain("src/beta.ts#Beta");
    // The shard must actually exist — otherwise this file is asserting that an ABSENT cache is transparent,
    // which it trivially is. That is the null-answer shape this project keeps re-finding.
    const dir = join(repo, ".seam", "rust", "def-table-v1", "f");
    expect(existsSync(dir), "no def-table-v1 shard was written — the disk layer is not engaged").toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });
});

describe("an edit invalidates it — the dangerous half", () => {
  test("a symbol ADDED after the cache was written is found", () => {
    locate("alpha");                                  // warm the shard
    w("src/gamma.ts", `export function gamma() { return 3; }\n`);
    const out = locate("gamma");
    // A stale table answers "No definition of 'gamma' found" — a false negative stated as a fact, which is the
    // exact failure `--locate` was uncapped to prevent in the first place.
    expect(out).not.toContain("No definition of");
    expect(out).toContain("src/gamma.ts#gamma");
  });

  test("a CHANGED SIGNATURE is re-read, not served from the cached text", () => {
    // Asserting on the SIGNATURE, not on a line number: `--locate` does not print lines, so moving a definition
    // down the file changes its output by nothing at all and could not detect staleness. The first draft of
    // this case did exactly that — an assertion that cannot fail is worse than no assertion.
    const before = locate("alpha");
    expect(before).toContain("export function alpha()");
    w("src/alpha.ts", `export function alpha(scale: number, label: string) { return scale; }\n`);
    const after = locate("alpha");
    expect(after).toContain("src/alpha.ts#alpha");
    expect(after).toContain("scale: number, label: string");   // the NEW declaration text
    expect(after).not.toBe(before);
  });

  test("a DELETED symbol stops being reported", () => {
    locate("beta");
    rmSync(join(repo, "src/beta.ts"));
    const out = locate("Beta");
    expect(out).toContain("No definition of");
  });
});

describe("the capped enumeration is a true prefix, not an approximation", () => {
  test("--locate still finds a symbol in the last file scanned", () => {
    // The cache stores the UNCAPPED enumeration once and slices for callers that pass a limit, because
    // `enumerate_files` returns the instant it reaches `limit` in file order. If that prefix property were
    // ever untrue the slice would silently drop defs — and the symptom would be exactly the false negative
    // (`locate_recall.test.ts`) that the uncapping fixed. Cheap end-to-end guard on the same property.
    for (let i = 0; i < 40; i++) w(`src/bulk/f${String(i).padStart(3, "0")}.ts`, `export const pad${i} = ${i};\n`);
    w("src/zzz_last/Needle.ts", `export class Needle { find() { return "x"; } }\n`);
    const out = locate("Needle");
    expect(out).toContain("src/zzz_last/Needle.ts#Needle");
  });
});
