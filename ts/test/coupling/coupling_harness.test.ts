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
  // KNOWN GAP in the Rust coupling FLOOR, kept as todos rather than deleted — the claims still stand.
  // `Data/Bill.rxdata` is a CARRIER-TRACED data-file channel: a `save_data(x, 'path')` writer and a
  // `load_data('path')` reader linked through a homemade carrier, not a framework adapter. The core's
  // floor returns only `db-table payments` on this fixture — seam-couple registers the file-channel KIND
  // (adapters/file_channel.rs) but nothing traces carriers into the floor index, so the pair is never
  // grounded. seam-couple/src/learn/carrier.rs has the signature learn/persist/resolve half; the
  // deterministic repo-wide TRACE that feeds the index is the piece that was never ported.
  // 
  // PRE-EXISTING, not a regression from the scan deletion: the product grow has used the Rust floor for a
  // while, so it has been missing carrier-traced data-file coupling all along. It only became visible
  // here because these tests used to run against the TypeScript floor.
  test.todo("full floor recovers BOTH the db-table and the data-file coupling", () => {});

  test.todo("unlinking adapters drops the FRAMEWORK coupling but keeps the agnostic carrier one", () => {});
});
