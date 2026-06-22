// Layer 1 — the deterministic relevance FLOOR (cli/review_relevance.ts). Pure functions; the contract is
// suppress-ONLY-on-proof: `irrelevant` requires both the written and read fields pinned AND disjoint;
// anything unpinnable (whole-row, no extractable write) is `unknown`, never suppressed.
import { describe, expect, test } from "bun:test";
import { writtenFields, readFields, scoreRelevance } from "../../src/cli/review_relevance.js";

describe("writtenFields (added lines → written contract)", () => {
  test("assignment target, not RHS reads", () => {
    expect([...writtenFields(["  const fee = amount * 0.05;"])]).toEqual(["fee"]);   // fee written; amount is a read
  });
  test("object keys in a write call", () => {
    expect(new Set(writtenFields(['  db.insert({ amount, fee });']))).toEqual(new Set(["amount", "fee"]));
  });
});

describe("readFields (consumer → read fields + whole-object)", () => {
  test("select columns are pinned fields", () => {
    const r = readFields('supabase.from("payments").select("fee")');
    expect(r.fields.has("fee")).toBe(true);
    expect(r.wholeObject).toBe(false);
  });
  test("select('*') is whole-object (unprovable)", () => {
    expect(readFields('supabase.from("payments").select("*")').wholeObject).toBe(true);
  });
});

describe("scoreRelevance — suppress only on proof", () => {
  const repo = "test/fixtures/crossstack-repo";
  const changeFee = ["  const fee = amount * 0.05;"];
  test("relevant: change writes a field the reader reads", () => {
    expect(scoreRelevance(changeFee, "ui/Receipt.tsx", repo)).toBe("relevant");   // Receipt reads 'fee'
  });
  test("irrelevant: both sides pinned and disjoint (PROVEN unrelated)", () => {
    expect(scoreRelevance(changeFee, "ui/Audit.tsx", repo)).toBe("irrelevant");   // Audit reads only 'amount'
  });
  test("unknown: reader uses the whole object — can't prove either way", () => {
    expect(scoreRelevance(changeFee, "ui/Billing.tsx", repo)).toBe("unknown");    // Billing select('*')
  });
  test("unknown: change has no pinnable written field", () => {
    expect(scoreRelevance(["  doSomething();"], "ui/Receipt.tsx", repo)).toBe("unknown");
  });
});
