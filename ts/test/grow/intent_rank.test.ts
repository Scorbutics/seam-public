// DETERMINISTIC intent-relevance ranking of a grown footprint (the "rank, don't crop" primitive). Two
// layers: the pure rank-banding (fast, no model), and the real embedding ranking (guarded — needs the
// transformers model; skipped where unavailable, e.g. the bundled .vsix or offline CI). The embedding
// layer is what was validated to recover the XPLAN spine over the JSON-schema/DocuSign noise on a real repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { annotateIntentRelevance } from "../../src/codebase/grow/intent_rank.js";

// The pure rank-banding and intent-spine member marking moved to the CORE. Their claims are pinned as Rust
// unit tests in `rust/crates/seam-grow/src/intent_rank.rs` (same eight assertions, same numbers) and the
// port is covered differentially by `rust/parity/intent_rank.ts`. Keeping a second copy here would only
// re-test the napi wrapper. What remains below is the EMBEDDING layer, which is still TypeScript.

describe("annotateIntentRelevance — no-op guards", () => {
  test("no intent → false, no mutation", async () => {
    const clusters = [{ seams: [{ id: "s1", primary: { file: "x.ts", symbol: "f" } }] }];
    expect(await annotateIntentRelevance("/tmp", undefined, clusters)).toBe(false);
    expect((clusters[0].seams[0] as any).relevance).toBeUndefined();
  });
});

// Real embedding ranking — guarded on model availability (returns false → skipped). Validates the core
// claim: a payment-intent ranks the payment def above an unrelated logging util, deterministically, no LLM.
describe("annotateIntentRelevance — embedding ranking (guarded)", () => {
  let REPO: string;
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "ir-repo-"));
    mkdirSync(join(REPO, "src"), { recursive: true });
    writeFileSync(join(REPO, "src", "pay.ts"), "export function chargePayment(amount: number) { /* charge the customer's card for the order total */ return amount; }\n");
    writeFileSync(join(REPO, "src", "log.ts"), "export function formatLogLine(level: string, msg: string) { /* format a timestamped log line for the console */ return level + msg; }\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("payment intent ranks the payment def above the logging util", async () => {
    const clusters = [{ seams: [
      { id: "pay", primary: { file: "src/pay.ts", symbol: "chargePayment" } },
      { id: "log", primary: { file: "src/log.ts", symbol: "formatLogLine" } },
    ] }];
    const ok = await annotateIntentRelevance(REPO, "how is a customer payment charged for an order", clusters);
    if (!ok) return;   // transformers unavailable (.vsix / offline CI) — graceful skip
    const pay = clusters[0].seams[0] as any, log = clusters[0].seams[1] as any;
    expect(typeof pay.relevance).toBe("number");
    expect(pay.relevance).toBeGreaterThan(log.relevance);
    expect(pay.tier).toBe("spine");
  });
});
