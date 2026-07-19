// Cross-stack overlay (grow/impact.ts) — impact keeps the SHARED-KEY half of a blast radius (a reader of a
// table the anchor writes) as ONE anchor overlay, WITHOUT the per-node data-coupling that used to make it
// O(closure) and disable the per-file footprint cache. Regression guard for that fix: the anchor `writeMember`
// writes the `members` db-table; `readMembers` reads it (the cross-stack side); `register` is a plain
// call-graph consumer. Hermetic tmp git repo built here, removed after. The cross-stack assertions need
// tree-sitter (couplingOtherSides resolves the complement span) and skip when the grammar is absent — the
// structural closure and the opt-out contract still run everywhere.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectImpact } from "../../src/codebase/grow/impact.js";
import { available } from "../../src/core/treesitter.js";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "seam-impact-xstack-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/db.ts"),
    `export const supabase = { from: (_t: string) => ({ insert: (x: unknown) => x, select: () => [] as unknown[] }) };\n`);
  writeFileSync(join(repo, "src/writer.ts"),
    `import { supabase } from "./db";\nexport function writeMember(name: string) { return supabase.from("members").insert({ name }); }\n`);
  writeFileSync(join(repo, "src/reader.ts"),
    `import { supabase } from "./db";\nexport function readMembers() { return supabase.from("members").select(); }\n`);
  writeFileSync(join(repo, "src/caller.ts"),
    `import { writeMember } from "./writer";\nexport function register(name: string) { return writeMember(name); }\n`);
  try { execSync("git init -q && git add -A", { cwd: repo, stdio: "ignore" }); } catch { /* git optional — fs-walk fallback */ }
});

afterAll(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("projectImpact — cross-stack overlay", () => {
  test("structural closure is the call-graph consumer; crossStack is always an array", async () => {
    const im = await projectImpact(repo, "src/writer.ts", "writeMember");
    expect(im.impacted.map((m) => m.symbol)).toContain("register");   // call-graph consumer
    expect(Array.isArray(im.crossStack)).toBe(true);                   // contract: field always present
  });

  test.skipIf(!available())("crossStack = the shared-key reader, NOT a member of the structural closure", async () => {
    const im = await projectImpact(repo, "src/writer.ts", "writeMember");
    const side = im.crossStack.find((c) => c.symbol === "readMembers");
    expect(side).toBeTruthy();                                         // the reader of the table the anchor writes
    expect(side!.file).toBe("src/reader.ts");
    expect(side!.edgeKind).toBe("db-read");
    expect(side!.via).toContain("members");
    expect(im.impacted.map((m) => m.symbol)).not.toContain("readMembers");  // a data crossing, not a caller
  });

  test("couplingOverlay:false opts out — crossStack empty, structural closure unchanged", async () => {
    const im = await projectImpact(repo, "src/writer.ts", "writeMember", { couplingOverlay: false });
    expect(im.crossStack).toEqual([]);
    expect(im.impacted.map((m) => m.symbol)).toContain("register");
  });
});
