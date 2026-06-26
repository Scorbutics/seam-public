// The grow drops TEST files by default (verification, not the spine — they flooded the globex footprint as
// `testCreateBooking*` consumers) and any node under an --exclude folder. Opt tests back in with includeTests.
// Structural contract: assert which consumer FILES survive the grow. Guards on tree-sitter (offline .vsix).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "fp-exclude-"));
  // a service method called by: a real consumer (src), a TEST (src/test/ dir), and a legacy folder.
  w("src/Bean.java", `package a;\npublic class Bean { public Booking createBooking(User u){ return repo.save(u); } }\n`);
  w("src/Svc.java", `package a;\npublic class Svc { private Bean b; public Booking create(User u){ return b.createBooking(u); } }\n`);
  w("src/test/BeanTest.java", `package a;\npublic class BeanTest { private Bean b; public void t(){ b.createBooking(null); } }\n`);
  w("legacy/OldCaller.java", `package a;\npublic class OldCaller { private Bean b; public void old(){ b.createBooking(null); } }\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const grownFiles = async (opts: any): Promise<string[]> => {
  const [data] = await grow_to_terminals(REPO, "src/Bean.java", "createBooking", { maxSteps: 4, ...opts });
  return [...new Set<string>(data.nodes.filter((n: any) => n.id !== "n1" && n.file).map((n: any) => n.file as string))];
};

describe("grow footprint exclusion (tests by default + --exclude folders)", () => {
  test("tests are dropped by default; the real consumer survives", async () => {
    if (!available()) return;
    const files = await grownFiles({});
    expect(files).toContain("src/Svc.java");          // real consumer kept
    expect(files).not.toContain("src/test/BeanTest.java");   // test dropped
  });

  test("includeTests keeps the test consumer", async () => {
    if (!available()) return;
    const files = await grownFiles({ includeTests: true });
    expect(files).toContain("src/test/BeanTest.java");
  });

  test("--exclude drops nodes under the named folder (and still drops tests)", async () => {
    if (!available()) return;
    const files = await grownFiles({ excludeDirs: ["legacy"] });
    expect(files).toContain("src/Svc.java");
    expect(files).not.toContain("legacy/OldCaller.java");
    expect(files).not.toContain("src/test/BeanTest.java");
  });
});
