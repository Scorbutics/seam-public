// applyMatchers LITERAL pre-filter: a tree-sitter rule re-parsed EVERY repo file (measured 16s/rule on
// cal.com). A rule can only match a file that literally contains its discriminator (the receiver/callee
// token, the directive prefix, the annotation name), so we skip the parse for files lacking it — 16s → 0.2s.
// This MUST be behaviour-preserving: a file that genuinely matches always contains the literal, so it is
// never skipped. These tests pin both halves: the literal map, and that a real hit still grounds.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { matcherLiteral, validateMatcher } from "../../src/codebase/coupling/key_ir.js";
import { applyMatchers } from "../../src/codebase/coupling/key_matcher.js";
import { available } from "../../src/codebase/atoms.js";

describe("matcherLiteral — the pre-filter discriminator", () => {
  test("returns the required substring per shape (null only for method, which has none)", () => {
    expect(matcherLiteral(validateMatcher({ via: "member", token: "prisma", verbs: ["findMany"], kind: "db-table", role: "consumes" })!)).toBe("prisma");
    expect(matcherLiteral(validateMatcher({ via: "call", token: "$emit", argIndex: 0, kind: "event", role: "produces" })!)).toBe("$emit");
    expect(matcherLiteral(validateMatcher({ via: "assign", token: "$scope", kind: "binding", role: "produces" })!)).toBe("$scope");
    expect(matcherLiteral(validateMatcher({ via: "attr", directive: "ng-", keyFrom: "call", kind: "binding", role: "consumes" })!)).toBe("ng-");
    expect(matcherLiteral(validateMatcher({ via: "annotation", annotation: "JmsListener", kind: "queue", role: "consumes" })!)).toBe("JmsListener");
    expect(matcherLiteral(validateMatcher({ via: "method", kind: "binding", role: "produces" })!)).toBeNull();
  });
});

describe("applyMatchers pre-filter is behaviour-preserving", () => {
  let REPO: string;
  beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "prefilter-")); });
  afterEach(() => { rmSync(REPO, { recursive: true, force: true }); });

  test("a file containing the token is STILL matched (pre-filter doesn't over-skip); one without grounds nothing", async () => {
    if (!available()) return;   // member rule executes via regex but the repo walk + parse path wants tree-sitter
    const w = (rel: string, t: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), t); };
    w("reader.ts", `export const f = () => prisma.booking.findMany();`);   // contains "prisma" → must match
    w("other.ts", `export const g = () => doStuff();`);                    // no "prisma" → skipped, contributes nothing

    const rule = validateMatcher({ via: "member", token: "prisma", verbs: ["findMany"], kind: "db-table", role: "consumes" })!;
    const idx = await applyMatchers(REPO, [rule]);
    const k = idx.get("db-table booking");
    expect(k).toBeDefined();
    expect(k!.consumers.map((c) => c.file)).toEqual(["reader.ts"]);   // matched the token-bearing file only
  });
});
