// REGRESSION — a `--center #NAME` anchor on a WRAPPED const (`export const NAME = withReporting(realFn, …)`, a
// sentry/HOC/reporting wrapper) bound to :0 with NO body, because `_named_units` only sees `const X = <arrow>`,
// not `const X = <call>`. So the grow had a bodyless anchor and stayed inferred (cal.com scheduleWorkflowReminders).
// `_wrappedDefSpan` redirects NAME to the WRAPPED function's real span — an inline arrow, or an identifier naming a
// same-file function — so the anchor gets the real body. Anchor-scoped (build_footprint's up/down seed), tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { makeCtx, lang_for, available } from "../../src/codebase/atoms.js";
import { _named_units, _wrappedDefSpan } from "../../src/codebase/scan/ast_units.js";
import { build_footprint } from "../../src/codebase/scan/index.js";

const ctxUnits = async (text: string) => { const ctx = (await makeCtx(text, lang_for("x.ts")!))!; return { ctx, units: _named_units(ctx) }; };

describe("_wrappedDefSpan resolves a wrapped-const anchor to the real impl", () => {
  test("`export const NAME = wrapper(realFn, …)` → the named same-file function's span (not the declarator, not :0)", async () => {
    if (!available()) return;
    const text = `const _impl = async (a: number) => {\n  const { doWork } = await import("./work");\n  return doWork(a);\n};\nexport const scheduleThing = withReporting(_impl, "scheduleThing");\n`;
    const { ctx, units } = await ctxUnits(text);
    expect(units.find((u) => u[0] === "scheduleThing")).toBeUndefined();          // the wrapped const is NOT a normal unit (the :0 cause)
    const impl = units.find((u) => u[0] === "_impl")!;                            // …but the impl IS
    expect(_wrappedDefSpan(ctx, "scheduleThing", units)).toEqual([impl[2], impl[3]]);   // redirect points at the impl's body
  });

  test("`const NAME = memo(() => {…})` → the inline arrow's span", async () => {
    if (!available()) return;
    const text = `export const Widget = memo(() => {\n  const x = compute();\n  return x;\n});\n`;
    const { ctx, units } = await ctxUnits(text);
    const span = _wrappedDefSpan(ctx, "Widget", units)!;
    expect(span).toBeTruthy();
    expect(span[1]).toBeGreaterThan(span[0]);                                     // a real multi-line body span, not [0,0]
  });

  test("a plain non-call const is not a wrapped def (null)", async () => {
    if (!available()) return;
    const { ctx, units } = await ctxUnits(`export const LIMIT = 42;\n`);
    expect(_wrappedDefSpan(ctx, "LIMIT", units)).toBeNull();
  });
});

describe("build_footprint gives a wrapped-const anchor a real span (not :0)", () => {
  let REPO: string;
  const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "wrapped-anchor-"));
    w("src/scheduler.ts", `const _run = async (n: number) => {\n  return helper(n);\n};\nfunction helper(n: number) { return n + 1; }\nexport const run = withReporting(_run, "run");\n`);
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the anchor node's range is the wrapped impl, not [0,0]", async () => {
    if (!available()) return;
    const g: any = await build_footprint(REPO, "src/scheduler.ts", "run", { direction: "down" });
    const anchor = (g.nodes ?? []).find((n: any) => n.id === "n1");
    expect(anchor).toBeTruthy();
    expect(anchor.range[1]).toBeGreaterThan(0);            // a real span (the `_run` impl), NOT the [0,0] name-only default
  });
});
