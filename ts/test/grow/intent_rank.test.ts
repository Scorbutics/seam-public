// DETERMINISTIC intent-relevance ranking of a grown footprint (the "rank, don't crop" primitive). Two
// layers: the pure rank-banding (fast, no model), and the real embedding ranking (guarded — needs the
// transformers model; skipped where unavailable, e.g. the bundled .vsix or offline CI). The embedding
// layer is what was validated to recover the XPLAN spine over the JSON-schema/DocuSign noise on a real repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bandTiers, annotateIntentRelevance, cropOffIntent } from "../../src/codebase/grow/intent_rank.js";

describe("rank-banding (pure, deterministic)", () => {
  test("top third → spine, middle → supporting, tail → off", () => {
    const seams = [0.1, 0.9, 0.5, 0.8, 0.2, 0.6].map((relevance, i) => ({ id: `s${i}`, relevance }));
    bandTiers(seams);
    const tierOf = (r: number) => (seams.find((s) => s.relevance === r) as any).tier;
    expect(tierOf(0.9)).toBe("spine");        // top
    expect(tierOf(0.8)).toBe("spine");
    expect(tierOf(0.6)).toBe("supporting");   // middle
    expect(tierOf(0.1)).toBe("off");          // tail
  });
  test("unscored seams are left alone", () => {
    const seams: any[] = [{ id: "a" }, { id: "b" }];
    bandTiers(seams);
    expect(seams.every((s) => s.tier === undefined)).toBe(true);
  });
});

describe("cropOffIntent (--spine-only) — deterministic, honest, lossless-by-reference", () => {
  test("drops tier=off, keeps spine+supporting, leaves stubs in cluster.omitted", () => {
    const clusters = [{ seams: [
      { id: "a", label: "Spine", tier: "spine", relevance: 0.9, primary: { file: "a.ts", symbol: "A" } },
      { id: "b", label: "Sup", tier: "supporting", relevance: 0.5, primary: { file: "b.ts", symbol: "B" } },
      { id: "c", label: "Off", tier: "off", relevance: 0.1, primary: { file: "c.ts", symbol: "C" } },
    ] }];
    const omitted = cropOffIntent(clusters);
    expect(omitted).toBe(1);
    expect(clusters[0].seams.map((s) => s.id)).toEqual(["a", "b"]);   // spine+supporting kept in full
    expect((clusters[0] as any).omitted).toEqual([{ id: "c", label: "Off", relevance: 0.1, file: "c.ts" }]);  // off → compact stub
  });
  test("no off seams → no crop, no omitted array", () => {
    const clusters = [{ seams: [{ id: "a", tier: "spine" }] }];
    expect(cropOffIntent(clusters)).toBe(0);
    expect((clusters[0] as any).omitted).toBeUndefined();
  });
  test("untiered seams (embeddings unavailable) are NOT cropped — degrades to full", () => {
    const clusters = [{ seams: [{ id: "a" }, { id: "b" }] }];   // no tier
    expect(cropOffIntent(clusters)).toBe(0);
    expect(clusters[0].seams).toHaveLength(2);
  });
});

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
