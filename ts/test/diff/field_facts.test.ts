// AST field-level extraction (the review-impact relevance floor, MOAT.md Gap 1) — cross-language:
// the floor now resolves read/written fields on Java/C++ readers the JS/TS regex floor can't, and the
// hero cross-stack case (JS change ↔ Java getter reader) grades correctly instead of false-suppressing.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { available } from "../../src/core/treesitter.js";
import { readFieldsOf, writtenFieldsOf } from "../../src/cli/field_facts.js";
import { readFields, scoreRelevanceAst } from "../../src/cli/review_relevance.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "field-facts");

describe("readFieldsOf — cross-language field reads", () => {
  test.skipIf(!available())("Java accessor getter getFee() → field 'fee' (not 'getFee')", async () => {
    const r = await readFieldsOf(repo, "PaymentView.java");
    expect(r).not.toBeNull();
    expect(r!.fields.has("fee")).toBe(true);
    expect(r!.fields.has("getFee")).toBe(false);   // the bean accessor is resolved to its field
  });
  test.skipIf(!available())("C++ arrow member payment->fee → field 'fee'", async () => {
    const r = await readFieldsOf(repo, "receipt.cpp");
    expect(r).not.toBeNull();
    expect(r!.fields.has("fee")).toBe(true);
  });
});

describe("writtenFieldsOf — cross-language writes in changed lines", () => {
  test.skipIf(!available())("Java setter setFee(v) on a changed line → 'fee'", async () => {
    const w = await writtenFieldsOf(repo, "setter.java", new Set([4]));   // payment.setFee(v) is line 4
    expect(w).not.toBeNull();
    expect(w!.has("fee")).toBe(true);
  });
});

describe("the regex floor MISSES the Java getter (why AST is the fix)", () => {
  test("regex readFields extracts 'getFee', NOT 'fee' — would falsely suppress the impact", () => {
    const r = readFields('return "fee: " + payment.getFee();');
    expect(r.fields.has("getFee")).toBe(true);
    expect(r.fields.has("fee")).toBe(false);
  });
});

describe("Gap 2 — sound binding: read-fields scoped to the key's data", () => {
  // Mixed.tsx selects 'amount' off `from('payments')` but also reads an unrelated `widget.fee`.
  test.skipIf(!available())("with the key, only the bound select column counts (widget.fee excluded)", async () => {
    const r = await readFieldsOf(repo, "Mixed.tsx", "payments");
    expect(r!.fields.has("amount")).toBe(true);
    expect(r!.fields.has("fee")).toBe(false);     // the unrelated widget.fee is NOT a payments field
  });
  test.skipIf(!available())("without the key, the whole-file scan still picks up widget.fee (the old behaviour)", async () => {
    const r = await readFieldsOf(repo, "Mixed.tsx");
    expect(r!.fields.has("fee")).toBe(true);       // proves the binding is what drops it, not extraction
  });
  test.skipIf(!available())("a change writing payments.fee is IRRELEVANT to Mixed (was a false 'relevant')", async () => {
    const verdict = await scoreRelevanceAst(repo, "writer.ts", new Set([2]), ["  const fee = amount * 0.05;"], "Mixed.tsx", "payments");
    expect(verdict).toBe("irrelevant");
  });
});

describe("scoreRelevanceAst — cross-stack JS change ↔ Java reader", () => {
  // the change writes `fee` (writer.ts line 2: `const fee = amount * 0.05;`).
  const changedLines = new Set([2]);
  const added = ["  const fee = amount * 0.05;"];
  test.skipIf(!available())("Java reader of getFee() is RELEVANT (AST resolves getFee→fee)", async () => {
    expect(await scoreRelevanceAst(repo, "writer.ts", changedLines, added, "PaymentView.java")).toBe("relevant");
  });
  test.skipIf(!available())("Java reader of getAmount() is IRRELEVANT (proven disjoint)", async () => {
    expect(await scoreRelevanceAst(repo, "writer.ts", changedLines, added, "AmountView.java")).toBe("irrelevant");
  });
});
