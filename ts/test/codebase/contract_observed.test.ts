// THE OBSERVED CONTRACT — what a module's exports DECLARE, and what their call sites actually DO.
//
// Why it exists: `--query contract` used to answer "who imports this" and stop. Measured in
// `bench/grep-vs-seam` run 1, that is not enough to act on — the arm holding Seam got 81 consumer NAMES with no
// argument-level information and then spent 28 grep calls recovering what the shape could have handed it. Naming
// a consumer is not describing a boundary.
//
// The two halves are asserted SEPARATELY because the useful signal is where they DISAGREE:
//   DECLARED — the signature as written, including through a wrapper (`const f = withReporting(_impl)`).
//   OBSERVED — call sites, edge-grained, with an argument-count histogram.
// A declared 3rd parameter that no call site passes is safe to narrow; an export with consumers but zero call
// sites is imported for its type, not invoked. Neither is visible from a consumer list.
//
// And the observed half is honest about its own grain: it matches by callee NAME, so a consuming file that
// declares the same name locally can inflate a count. That is reported as a GAP, not silently accepted — the
// same class of defect as the resolution bug pinned in `dep_name_binding.test.ts`.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { projectContract } from "../helpers/shapes.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

let contract: any;
const provided = (symbol: string): any => contract.provides.find((p: any) => p.symbol === symbol);

beforeAll(async () => {
  REPO = mkdtempSync(join(tmpdir(), "contract-obs-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "contract-obs", "version": "1.0.0" }`);

  w("src/api.ts", `function withReporting<T>(fn: T, _name: string): T { return fn; }

/** Declared with 3 params; callers below pass 1 and 2, never 3. */
export function charge(amount: number, currency?: string, idempotencyKey?: string): boolean {
  return amount > 0 && !!currency && !!idempotencyKey;
}

/** Consumed only as a TYPE — never invoked. */
export type Receipt = { id: string };

/** A funclike export imported but never called (passed on, not invoked). */
export function auditHook(event: string): void { void event; }

/** An exported CLIENT OBJECT — never itself called; consumers call METHODS on it. */
export const ledger = { record: (n: number) => n, close: () => true };

const _refund = async (id: string, reason: string): Promise<boolean> => {
  return !!id && !!reason;
};

/** The exported name is a WRAPPER over the real implementation. */
export const refund = withReporting(_refund, "refund");
`);

  // one call with 1 arg, one with 2 → two arity buckets for the same export
  w("src/checkout.ts", `import { charge, refund, ledger } from "./api";
import type { Receipt } from "./api";

export async function checkout(total: number): Promise<Receipt> {
  charge(total);
  charge(total, "EUR");
  await refund("r1", "duplicate");
  ledger.record(total);
  ledger.close();
  return { id: "x" };
}
`);

  // imports auditHook but never calls it; ALSO declares its own \`charge\` → the shadowed-name gap
  w("src/registry.ts", `import { auditHook } from "./api";
import type { Receipt } from "./api";

const hooks = [auditHook];

function charge(n: number) { return n; }

export function registered(): number { return hooks.length + charge(1); }

export function receiptOf(): Receipt { return { id: "y" }; }
`);

  contract = await projectContract(REPO, "src/api.ts");
});

afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

describe("declared half — the signature a caller has to satisfy", () => {
  test("a plain function reports its parameter list and return type", () => {
    expect(provided("charge").signature).toBe("(amount: number, currency?: string, idempotencyKey?: string): boolean");
  });

  test("a WRAPPED const export reports the IMPLEMENTATION's signature, not the wrapper's", () => {
    // `export const refund = withReporting(_refund, "refund")` — a caller must satisfy `_refund`, and the
    // wrapper call is not a signature at all. Before the enrichment there was no signature field to be wrong.
    expect(provided("refund").signature).toBe("(id: string, reason: string): Promise<boolean>");
  });

  test("a non-funclike export reports ABSENCE, not an empty signature", () => {
    expect(provided("Receipt").signature ?? null).toBeNull();
  });

  test("an exported OBJECT literal has no signature — not the shape of a property inside it", () => {
    // The first version of this resolved a const binding by matching a SPAN START LINE, so
    // `export const ledger = { record: (n: number) => n, … }` reported `(n: number)` — the signature of an
    // inner property, presented as the export's own. Caught on `crossstack-repo/lib/db.ts` in the CLI gate.
    expect(provided("ledger").signature ?? null).toBeNull();
  });

  test("the signature is one line even when the source spans several", () => {
    for (const p of contract.provides) expect(p.signature ?? "").not.toContain("\n");
  });
});

describe("observed half — what the call sites actually do", () => {
  test("call sites are EDGE-grained, and the arity histogram shows the unused tail", () => {
    const ob = provided("charge").observed;
    // `src/checkout.ts` calls it twice; `src/registry.ts` calls its OWN local `charge` once, which is counted
    // too (see the gap test below) — so 3 sites, and the render says so rather than pretending otherwise.
    expect(ob.callSites).toBe(3);
    // ascending by argument count: 1 arg twice (checkout + registry's local), 2 args once
    expect(ob.arity).toEqual([[1, 2], [2, 1]]);
    // THE ACTIONABLE FACT: 3 declared parameters, no call site passes more than 2 — the 3rd is unexercised.
    expect(Math.max(...ob.arity.map(([argc]: number[]) => argc))).toBe(2);
  });

  test("an export with consumers but NO call site is distinguished from an uncalled one", () => {
    const hook = provided("auditHook");
    expect(hook.consumerCount).toBe(1);   // registry.ts imports it
    expect(hook.observed.callSites).toBe(0); // ...and never invokes it
  });

  test("a type-only export has no observed calls", () => {
    expect(provided("Receipt").observed.callSites).toBe(0);
  });

  test("an export used as a RECEIVER is not reported as uncalled", () => {
    // `ledger.record(…)` / `ledger.close()` never CALL `ledger`, so a callee-name-only scan sees zero and the
    // render said "imported but never invoked" — false about a symbol used at every site. Receiver uses are
    // counted separately so the two cases stay distinguishable rather than collapsing into a wrong claim.
    const ob = provided("ledger").observed;
    expect(ob.callSites).toBe(0);
    expect(ob.receiverSites).toBe(2);
  });
});

describe("the observed half declares its own grain", () => {
  test("a consuming file that declares the same name locally is reported as a GAP", () => {
    const g = (contract.gaps ?? []).find((x: any) => x.mechanism === "contract-shadowed-name");
    expect(g).toBeDefined();
    // it names the file, so the reader can check the one place the count could be high
    expect(g.evidence).toContain("src/registry.ts");
  });
});
