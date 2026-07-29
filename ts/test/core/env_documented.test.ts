// THE SEAM_* REFERENCE IS ENFORCED, NOT PROMISED.
//
// `src/core/seam_env.ts` documents every environment flag the engine reads. A hand-maintained list drifts —
// measured, before it existed: 6 flags were documented in prose and never implemented, and 16 had no reader at
// all (docs/SEAM_FLAGS_AUDIT.md). So this scans BOTH engines for actual reads and fails on drift in either
// direction: an undocumented flag, or a documented one nothing reads any more.
//
// Detection matches the audit's method, which took three attempts to get right:
//   · a READ is the name as a QUOTED string argument (`env_is("SEAM_X")`, `env_num("SEAM_X", 16)`) or after
//     `process.env.` — NOT a bare mention, because most flags are also named in the comment above their own
//     read, and counting those made dead flags look live.
//   · assignments (`process.env.SEAM_X = …`) are writes, not reads.
//   · `//` comments are stripped first.
//   · tests and parity harnesses are excluded: they SET flags, and a flag only tests set is still one the
//     engine reads.
// A name built at runtime would defeat this, so the audit checked for that too — nothing constructs a
// `SEAM_*` name with a template or `format!`.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEAM_FLAGS, flagDoc } from "../../src/core/seam_env.js";

const ROOTS = [join(import.meta.dir, "..", "..", "src"), join(import.meta.dir, "..", "..", "..", "rust", "crates")];
const SKIP = new Set(["node_modules", "target", ".git", ".seam"]);

function sources(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    // seam_env.ts is EXCLUDED, and that is load-bearing rather than tidiness: the registry lists every flag
    // name as a quoted string, so counting it as a source makes every documented flag trivially "read" and
    // the orphan check below vacuous. Caught by falsifying — documenting a flag nothing reads PASSED until
    // this exclusion existed.
    else if (/\.(ts|rs)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== "seam_env.ts") out.push(p);
  }
  return out;
}

function flagsRead(): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of ROOTS) {
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf-8");
      text.split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        for (const name of new Set(code.match(/SEAM_[A-Z0-9_]+/g) ?? [])) {
          const quoted = new RegExp(`["']${name}["']`).test(code);
          const dotted = new RegExp(`process\\.env\\.${name}\\b`).test(code);
          const assigned = new RegExp(`process\\.env\\.${name}\\s*=[^=]`).test(code);
          if ((quoted || dotted) && !assigned && !found.has(name)) found.set(name, `${file}:${i + 1}`);
        }
      });
    }
  }
  return found;
}

describe("the SEAM_* environment reference covers exactly what the engine reads", () => {
  const read = flagsRead();

  test("the scan itself finds something — a broken scanner would pass everything", () => {
    // guards the whole test: if `sources()` or the read regex silently matched nothing, every assertion below
    // would trivially hold. Two flags are certain (one per engine, both consolidated switches).
    expect(read.size).toBeGreaterThan(20);
    expect([...read.keys()]).toContain("SEAM_DEBUG");
    expect([...read.keys()]).toContain("SEAM_RENDER");
  });

  test("every flag the engine reads is documented in seam_env.ts", () => {
    const undocumented = [...read.entries()].filter(([n]) => !flagDoc(n)).map(([n, at]) => `${n} (read at ${at})`);
    expect(undocumented).toEqual([]);
  });

  test("every documented flag is still read — a doc entry for a deleted flag is a lie", () => {
    const orphaned = SEAM_FLAGS.filter((f) => !read.has(f.name)).map((f) => f.name);
    expect(orphaned).toEqual([]);
  });

  test("each entry says what it defaults to and what it changes", () => {
    // an entry with an empty default or effect documents the NAME and nothing useful
    const thin = SEAM_FLAGS.filter((f) => f.dflt.trim().length < 2 || f.effect.trim().length < 20).map((f) => f.name);
    expect(thin).toEqual([]);
  });

  test("no duplicate entries", () => {
    const names = SEAM_FLAGS.map((f) => f.name);
    expect(names.length).toBe(new Set(names).size);
  });
});
