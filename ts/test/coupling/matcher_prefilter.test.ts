// applyMatchers LITERAL pre-filter: a tree-sitter rule re-parsed EVERY repo file (measured 16s/rule on
// cal.com). A rule can only match a file that literally contains its discriminator (the receiver/callee
// token, the directive prefix, the annotation name), so we skip the parse for files lacking it — 16s → 0.2s.
// This MUST be behaviour-preserving: a file that genuinely matches always contains the literal, so it is
// never skipped. These tests pin both halves: the literal map, and that a real hit still grounds.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { matcherLiteral, validateMatcher, runMatcher } from "../../src/codebase/coupling/key_ir.js";
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
    // use a verb the member-access FLOOR adapter does NOT cover (`load` is generic, excluded), so the matcher's
    // hit isn't reconciled away by the floor — this isolates the pre-filter, not the floor.
    w("reader.ts", `export const f = () => prisma.booking.load();`);      // contains "prisma" → must match
    w("other.ts", `export const g = () => doStuff();`);                    // no "prisma" → skipped, contributes nothing

    const rule = validateMatcher({ via: "member", token: "prisma", verbs: ["load"], kind: "db-table", role: "consumes" })!;
    const idx = await applyMatchers(REPO, [rule]);
    const k = idx.get("db-table booking");
    expect(k).toBeDefined();
    expect(k!.consumers.map((c) => c.file)).toEqual(["reader.ts"]);   // matched the token-bearing file only
  });
});

// The SAME gate on the runPipeline PER-NODE loop (the previously un-filtered site — the cal.com hotspot).
// runMatcher itself now short-circuits, so every caller (pipeline + grounding) benefits. Offline (regex shape).
describe("runMatcher pre-filter is behaviour-preserving", () => {
  const repoM = validateMatcher({ via: "repository", token: "bookingRepo", verbs: ["save", "create"], kind: "db-table", role: "produces" })!;
  const callM = validateMatcher({ via: "call", token: "emitEvent", argIndex: 0, kind: "event", role: "consumes" })!;

  test("a real match is KEPT (literal present, pattern matches)", async () => {
    const hits = await runMatcher(repoM, "svc.ts", `export function f(){ bookingRepo.save({ id: 1 }); }`);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].value).toBe("bookingRepo");
  });

  test("literal ABSENT → empty, and correct (the pattern could not match anyway)", async () => {
    expect((await runMatcher(repoM, "svc.ts", `export function f(){ otherRepo.save({ id: 1 }); }`)).length).toBe(0);
  });

  test("literal present but pattern does NOT match → empty (the regex, not the gate, decides)", async () => {
    expect((await runMatcher(repoM, "svc.ts", `const note = "bookingRepo is our data layer";`)).length).toBe(0);
  });

  test("gate literal only in a COMMENT → empty (raw-text gate is a safe superset; masking still rejects)", async () => {
    expect((await runMatcher(callM, "svc.ts", `// emitEvent('sync') is called elsewhere\nexport const x = 1;`)).length).toBe(0);
    // the same call in CODE IS matched — the gate did not over-skip
    expect((await runMatcher(callM, "svc.ts", `export function f(){ emitEvent('sync'); }`)).length).toBeGreaterThan(0);
  });
});
