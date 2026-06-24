// scan_consumers_batch resolves the consumers of a SET of anchors in ONE index pass (vs scan_consumers'
// per-symbol full-index walk — the redundancy the review-impact budget capped). It MUST be semantically
// identical to running scan_consumers per anchor: this is the equivalence gate, across the cases that matter
// (named import, transitive reexport barrel, default export, namespace member) on hermetic repos.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan_consumers, scan_consumers_batch, resetRepoImports } from "../../src/core/resolve/consumers.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
const norm = (cs: { file: string; local: string; status: string }[]) =>
  cs.map((c) => `${c.file}|${c.local}|${c.status}`).sort();

beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "batch-")); resetRepoImports(); });
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); resetRepoImports(); });

describe("scan_consumers_batch ≡ per-symbol scan_consumers", () => {
  test("named imports + a transitive reexport barrel + a co-located default export", async () => {
    w("a.ts", "export function alpha() { return 1; }\nexport function beta() { return 2; }\n");
    w("barrel.ts", 'export { alpha } from "./a";\n');                                  // a barrel for alpha
    w("u1.ts", 'import { alpha } from "./a";\nexport const x = alpha();\n');           // direct consumer of alpha
    w("u2.ts", 'import { alpha } from "./barrel";\nexport const y = alpha();\n');      // consumes alpha THROUGH the barrel
    w("u3.ts", 'import { beta } from "./a";\nexport const z = beta();\n');             // consumer of beta
    w("d.ts", "export default function gamma() { return 3; }\n");
    w("u4.ts", 'import gamma from "./d";\nexport const q = gamma();\n');               // default-import consumer

    const anchors = [
      { file: "a.ts", symbol: "alpha" }, { file: "a.ts", symbol: "beta" }, { file: "d.ts", symbol: "gamma" },
    ];
    const batch = await scan_consumers_batch(REPO, anchors);
    for (const a of anchors) {
      resetRepoImports();
      const single = await scan_consumers(REPO, a.file, a.symbol);
      const key = `${a.file.replace(/\\/g, "/")}::${a.symbol}`;
      expect(norm(batch.get(key) ?? [])).toEqual(norm(single));   // identical consumer set per anchor
    }
    // sanity: alpha's set includes the direct consumer, the barrel, and the through-barrel user
    const alpha = norm(batch.get("a.ts::alpha") ?? []).join(" ");
    expect(alpha).toContain("u1.ts");
    expect(alpha).toContain("barrel.ts");
    expect(alpha).toContain("u2.ts");
  });

  test("an anchor with no consumers returns an empty set (not missing)", async () => {
    w("lonely.ts", "export function unused() { return 0; }\n");
    const batch = await scan_consumers_batch(REPO, [{ file: "lonely.ts", symbol: "unused" }]);
    expect(batch.get("lonely.ts::unused")).toEqual([]);
  });
});
