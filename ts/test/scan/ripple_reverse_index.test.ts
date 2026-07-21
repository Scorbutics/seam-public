// DEPTH-2 RIPPLE (`_depth2_ripple`) — the up-direction consumer resolution. It used to re-read + text-scan
// EVERY repo source file to find who imports a depth-1 consumer; on a cold structural UP-grow that whole-repo
// walk is the dominant cost (measured on cal.com: up-resolution is 100–1000× the down side; the walk alone was
// 76s → 3.5s once replaced). SEAM_RIPPLE_INDEX=1 sources the candidate importer files from the cached
// reverse-import index (`fileImporters`) instead — a file-level SUPERSET, so the inner parse_imports symbol match
// still filters exactly, and the walk order is preserved so node ids match. This pins that the reverse-index path
// yields the SAME node set as the full walk (the byte-identical contract) AND that the ripple still fires (the
// depth-2 consumer is found). Hermetic tmp git repo; tree-sitter-gated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build_footprint } from "../../src/codebase/scan/index.js";
import { available } from "../../src/core/treesitter.js";

let repo: string;
const names = (g: { nodes?: { file: string; symbol: string }[] }) => (g.nodes ?? []).map((n) => `${n.file}#${n.symbol}`).sort();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "seam-ripple-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  // core ← mid (depth-1 consumer) ← top (depth-2 consumer, reached only by the ripple). decoy imports nothing:
  // the reverse-index must SKIP it (it imports no target) without dropping the real depth-2 node.
  writeFileSync(join(repo, "src/core.ts"), `export function coreFn() { return 1; }\n`);
  writeFileSync(join(repo, "src/mid.ts"), `import { coreFn } from "./core";\nexport function midFn() { return coreFn() + 1; }\n`);
  writeFileSync(join(repo, "src/top.ts"), `import { midFn } from "./mid";\nexport function topFn() { return midFn() + 1; }\n`);
  writeFileSync(join(repo, "src/decoy.ts"), `export function decoy() { return 99; }\n`);
  try { execSync("git init -q && git add -A", { cwd: repo, stdio: "ignore" }); } catch { /* git optional */ }
});

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("depth-2 ripple — reverse-index candidates == full walk", () => {
  test("SEAM_RIPPLE_INDEX yields the identical node set, and the ripple still finds the depth-2 consumer", async () => {
    if (!(await available())) return;   // tree-sitter absent (offline CI / .vsix) → degrade, don't fail
    const prev = process.env.SEAM_RIPPLE_INDEX;
    try {
      process.env.SEAM_RIPPLE_INDEX = "0";     // kill-switch → the old full-walk baseline
      const off = await build_footprint(repo, "src/core.ts", "coreFn", { direction: "up", depth: 2, dataCoupling: false });
      delete process.env.SEAM_RIPPLE_INDEX;    // DEFAULT (on) → reverse-index candidates
      const on = await build_footprint(repo, "src/core.ts", "coreFn", { direction: "up", depth: 2, dataCoupling: false });

      expect(names(on)).toEqual(names(off));                                   // BYTE-IDENTICAL node set
      expect(names(off).some((x) => /\bmid/.test(x) || x.includes("midFn"))).toBe(true);   // depth-1 consumer present
      expect(names(off).some((x) => x.includes("topFn"))).toBe(true);          // depth-2 RIPPLE consumer found (proves the ripple fired)
      expect(names(on).some((x) => x.includes("topFn"))).toBe(true);           // …and the reverse-index path still finds it
      expect(names(off).some((x) => x.includes("decoy"))).toBe(false);         // non-importer excluded (both paths)
    } finally { if (prev === undefined) delete process.env.SEAM_RIPPLE_INDEX; else process.env.SEAM_RIPPLE_INDEX = prev; }
  });
});
