// REGRESSION — the data-coupling OTHER-SIDE lookup must exclude TEST/fixture files. A `.integration-test`/
// `.e2e-spec`/seed file that writes or reads the subject table is not a real coupling counterpart of the flow;
// including it floods the subject's producer/consumer set with fixtures and crowds out the real ones (observed on
// cal.com: `booking`'s write-set was dominated by `*.integration-test.ts` writers, so the true create write and
// the real alternate entry points fell below the reader cap). The grow excludes tests everywhere else by default;
// otherSide was the last path that didn't. Assert the STRUCTURAL contract: a real cross-file writer of the table
// the anchor reads surfaces as a coupling crossing; a same-table writer in an integration-test file does NOT.
// Guards on tree-sitter (the `.from()` floor parses the files).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "coupling-testexcl-"));
  // ANCHOR reads `things` → the coupling other-side lookup surfaces the table's WRITERS (producers).
  w("api/service.ts", `import { supabase } from "./db";\n` +
    `export function loadThings() {\n  return supabase.from("things").select("*");\n}\n`);
  // A REAL writer of `things` — must surface as a coupling crossing.
  w("api/writer.ts", `import { supabase } from "./db";\n` +
    `export function saveThing(name: string) {\n  return supabase.from("things").insert({ name });\n}\n`);
  // A TEST-FILE writer of the SAME table — must NOT surface (it is a fixture, not a counterpart of the flow).
  w("api/things.integration-test.ts", `import { supabase } from "./db";\n` +
    `export function seedThings() {\n  return supabase.from("things").insert({ name: "fixture" });\n}\n`);
  w("api/db.ts", `export const supabase = {} as any;\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const grownFiles = async (): Promise<Set<string>> => {
  const [data]: any = await grow_to_terminals(REPO, "api/service.ts", "loadThings", { maxSteps: 40, maxNodes: 200, dataCoupling: true } as any);
  return new Set((data.nodes ?? []).map((n: any) => String(n.file)));
};

describe("coupling other-side lookup excludes test-file counterparts", () => {
  test("a real cross-file writer of the read table surfaces as a crossing", async () => {
    if (!available()) return;
    expect(await grownFiles()).toContain("api/writer.ts");
  });

  test("a same-table writer in an integration-test file is NOT surfaced", async () => {
    if (!available()) return;
    expect(await grownFiles()).not.toContain("api/things.integration-test.ts");
  });
});
