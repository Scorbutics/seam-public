// The learned-adapter LEDGER (Gap 3 — flywheel surfacing): persisting a learned adapter records it as
// `learned`, and a later cache HIT records it as `used` — so a run can report which `.seam/` adapters it
// grew + replayed (reviewable/promotable), pure observability.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerSnapshot, resetLedger } from "../../src/codebase/coupling/ledger.js";
import { persistFileKeys, cachedFileKeys, _resetKeyCacheMem } from "../../src/codebase/coupling/key_cache.js";

afterEach(() => { resetLedger(); _resetKeyCacheMem(); });

describe("adapter ledger", () => {
  test("persist → learned, then a cache hit → used", () => {
    resetLedger(); _resetKeyCacheMem();
    const repo = mkdtempSync(join(tmpdir(), "seam-ledger-"));
    try {
      persistFileKeys(repo, "svc.ts#abc123", {
        name: "acme-orm", description: "homemade ORM .save()/.load()",
        keys: [{ kind: "db-table", value: "orders", line: 3, produces: true }],
      });
      expect(ledgerSnapshot().learned).toContain("acme-orm");      // learning recorded
      expect(ledgerSnapshot().used).toEqual([]);                   // not used yet

      const hit = cachedFileKeys(repo, "svc.ts#abc123");           // a later (even offline) run replays it
      expect(hit.hit).toBe(true);
      expect(ledgerSnapshot().used.map((u) => u.name)).toContain("acme-orm");
      expect(ledgerSnapshot().used.find((u) => u.name === "acme-orm")?.scope).toBe("repo");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("resetLedger clears it (per-run isolation for the in-process harness)", () => {
    const repo = mkdtempSync(join(tmpdir(), "seam-ledger-"));
    try {
      persistFileKeys(repo, "x#1", { name: "n", description: "", keys: [] });
      expect(ledgerSnapshot().learned.length).toBeGreaterThan(0);
      resetLedger();
      expect(ledgerSnapshot()).toEqual({ used: [], learned: [] });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
