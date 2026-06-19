// The data-coupling harness + the framework-agnostic unlink scaffold. On a fixture with BOTH a
// framework coupling (ActiveRecord `payments` db-table) and a homemade-carrier coupling
// (`Data/Bill.rxdata` data-file): the full floor recovers both; unlinking the hand-written adapters
// (SEAM_NO_ADAPTERS) drops the framework one but KEEPS the carrier one — the carrier axis has no adapter
// to unlink, it's agnostic by construction. (Fresh repo copies per config dodge the per-repo index cache,
// the way the CLI's separate processes do.)
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCouplingCase, type CouplingCase } from "../../eval/coupling_harness.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "eval", "coupling-fixtures", "psdk-mini");
const freshRepo = () => { const d = mkdtempSync(join(tmpdir(), "seam-ch-")); cpSync(FIXTURE, d, { recursive: true }); rmSync(join(d, ".seam"), { recursive: true, force: true }); return d; };
const CASE: CouplingCase = { name: "billing", repo: "", anchorFile: "billing.rb", symbol: "charge", expect: [{ value: "payments" }, { value: "Data/Bill.rxdata" }] };

describe("data-coupling harness", () => {
  test("full floor recovers BOTH the db-table and the data-file coupling", async () => {
    const s = await scoreCouplingCase(freshRepo(), CASE);
    expect(s.recall).toBe(1);
    expect(s.recovered).toContain("payments");
    expect(s.recovered).toContain("Data/Bill.rxdata");
  });

  test("unlinking adapters drops the FRAMEWORK coupling but keeps the agnostic carrier one", async () => {
    const s = await scoreCouplingCase(freshRepo(), CASE, { noAdapters: true });
    expect(s.missing).toEqual(["payments"]);              // the hand-written active_record adapter is gone
    expect(s.recovered).toContain("Data/Bill.rxdata");    // carrier-channel survives — no adapter to unlink
    expect(s.recall).toBe(0.5);
  });
});
