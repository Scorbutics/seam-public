// REGRESSION — a WRAPPED default export ("export default withReporting(getSlots, "getSlots")") reported
// "No callers" for a symbol with real default-importers.
//
// MEASURED on cal.com: `--query consumers --center
// "packages/features/schedules/lib/slots.ts#getSlots"` rendered `resolution: FULL | resolved: 0 usage sites`
// + "## No callers — Nothing in the repo calls this symbol", while `getSlots` (declared at :232, put on the
// module boundary by `export default withReporting(getSlots, "getSlots")` at :264) is default-imported by
// three files. A CONFIDENT FALSE NEGATIVE — the class of failure that tells an engineer their live code is
// dead — and it slipped past both existing guards: the anchor IS declared (so the undeclared-anchor error
// can't fire) and the default slot is a CALL, not the bare identifier the default-export gate could read.
//
// ROOT CAUSE: `_isDefaultExport` tested the default slot with a name regex (`export default <symbol>`), so a
// slot filled by a WRAPPER CALL matched no member. Every default-import consumer was then dropped by the one
// grounded gate that admits them. The fix asks the file's LANGUAGE provider for the slot and unwraps the
// wrapper to the first identifier argument naming a funclike of that same file — the same rule the AST-side
// `_wrappedDefSpan` already uses for `const X = withReporting(realFn)`.
//
// The three invariants this pins, in one fixture:
//   (1) RECALL      — default-importers of a WRAPPED default export are found (incl. a NESTED wrapper).
//   (2) HONESTY     — a declared symbol with genuinely no consumers still reports no callers.
//   (3) NO GUESSING — no name matching (a same-named symbol in another module is not linked), and a
//                     non-funclike argument of the wrapper call is not adopted as the default; an OPAQUE
//                     slot is reported as a BLINDSPOT rather than asserted or silently zeroed.
// Hermetic tmp repo; tree-sitter-gated.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/footprint.js";
import { projectConsumerSet } from "../../src/codebase/grow/project_set.js";
import { projectContract } from "../helpers/shapes.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

const consumersOf = async (file: string, symbol: string) => {
  const set = projectConsumerSet(await build_footprint(REPO, file, symbol, { direction: "up", depth: 1, dataCoupling: false }));
  return set;
};
const resolvedFiles = (set: { members: { file: string; provenance: string }[] }) =>
  new Set(set.members.filter((m) => m.provenance !== "SUGGESTED").map((m) => m.file));

// THE FIXTURE IS THE EXPECTATION — these are the files that default-import the wrapped export, so the
// asserted set is read off this list, not invented.
const WRAPPED_IMPORTERS = ["src/callerA.ts", "src/callerB.ts"];

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "wrapped-default-export-"));
  w("src/wrap.ts", `export function withReporting<T>(fn: T, _name: string): T {\n  return fn;\n}\n\nexport function withCache<T>(fn: T): T {\n  return fn;\n}\n`);

  // (1) THE DEFECT — the default slot is a WRAPPER CALL over a local declaration. `getSlots` is NOT a named
  // export: the module's whole public surface is this slot. `options` is a declared const that is ALSO an
  // argument of the same call — it must NOT be adopted as the default (it is not a funclike).
  w("src/slots.ts", `import { withReporting } from "./wrap";\n\nconst options = { verbose: true };\n\n`
    + `const getSlots = (day: string): string[] => {\n  return [day, String(options.verbose)];\n};\n\n`
    + `export default withReporting(getSlots, "getSlots");\n`);
  w("src/callerA.ts", `import getSlots from "./slots";\n\nexport function planA(): string[] {\n  return getSlots("mon");\n}\n`);
  w("src/callerB.ts", `import renamedSlots from "./slots";\n\nexport function planB(): string[] {\n  return renamedSlots("tue");\n}\n`);

  // NESTED wrapper — `withReporting(withCache(fn))`.
  w("src/nested.ts", `import { withReporting, withCache } from "./wrap";\n\n`
    + `function buildReport(id: string): string {\n  return id;\n}\n\n`
    + `export default withReporting(withCache(buildReport), "buildReport");\n`);
  w("src/callerNested.ts", `import report from "./nested";\n\nexport function useReport(): string {\n  return report("x");\n}\n`);

  // (2) HONESTY — declared, exported, and genuinely used by nobody.
  w("src/orphan.ts", `export function neverCalled(): string {\n  return "nothing uses me";\n}\n`);

  // (3a) NO NAME MATCHING — a DIFFERENT module declaring a symbol of the SAME name (`getSlots`) with its own
  // default-importer. Linking by name would attribute this importer to src/slots.ts#getSlots.
  w("src/other/slots.ts", `import { withReporting } from "../wrap";\n\n`
    + `const getSlots = (day: string): string[] => {\n  return [day];\n};\n\n`
    + `export default withReporting(getSlots, "getSlots");\n`);
  w("src/other/caller.ts", `import otherSlots from "./slots";\n\nexport function planOther(): string[] {\n  return otherSlots("wed");\n}\n`);

  // (3b) OPAQUE slot — an anonymous arrow fills the default; no declaration of this file can carry its
  // importers. `helper` is declared, exported, and not used anywhere.
  w("src/opaque.ts", `export function helper(x: string): string {\n  return x;\n}\n\nexport default (x: string): string => x + "!";\n`);
  w("src/callerOpaque.ts", `import opaque from "./opaque";\n\nexport function useOpaque(): string {\n  return opaque("y");\n}\n`);

  resetRepoImports();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); resetRepoImports(); });

describe("a WRAPPED default export links its default-importers to the local declaration", () => {
  test("the wrapped local's default-importers are found (the false negative)", async () => {
    if (!available()) return;
    const set = await consumersOf("src/slots.ts", "getSlots");
    const files = resolvedFiles(set);
    for (const rel of WRAPPED_IMPORTERS) expect(files).toContain(rel);   // the regression: this set was EMPTY
    expect(set.noStructure).toBeUndefined();
    // …including the importer that binds the default under a name of its OWN (`renamedSlots`) — a name match
    // could never have found it.
    expect(files).toContain("src/callerB.ts");
  });

  test("a NESTED wrapper resolves too", async () => {
    if (!available()) return;
    expect(resolvedFiles(await consumersOf("src/nested.ts", "buildReport"))).toContain("src/callerNested.ts");
  });

  test("the module CONTRACT sees the default slot as public surface", async () => {
    if (!available()) return;
    const c = await projectContract(REPO, "src/slots.ts");
    const p = c.provides.find((x) => x.symbol === "getSlots");
    expect(p).toBeDefined();
    expect(new Set(p!.consumers.map((x) => x.file))).toEqual(new Set(WRAPPED_IMPORTERS));
    expect(c.afferent).toBe(WRAPPED_IMPORTERS.length);   // fan-in was 0 for a module with real importers
  });
});

describe("the honest empty result is preserved", () => {
  test("a declared symbol with genuinely no consumers still reports no callers", async () => {
    if (!available()) return;
    const set = await consumersOf("src/orphan.ts", "neverCalled");
    expect(resolvedFiles(set).size).toBe(0);
    expect(set.noStructure).toBe(true);
    expect(set.reason).toBe("none");
    expect(set.unresolved).toEqual([]);
  });
});

describe("nothing is linked by NAME, and an unprovable slot is a blindspot — never a guess", () => {
  test("a same-named symbol in another module keeps its own importers", async () => {
    if (!available()) return;
    expect(resolvedFiles(await consumersOf("src/slots.ts", "getSlots"))).not.toContain("src/other/caller.ts");
    expect(resolvedFiles(await consumersOf("src/other/slots.ts", "getSlots"))).not.toContain("src/callerA.ts");
  });

  test("a non-funclike argument of the wrapper call is not adopted as the default export", async () => {
    if (!available()) return;
    // `options` is an argument-adjacent local const of src/slots.ts; it must not inherit the slot's importers.
    expect(resolvedFiles(await consumersOf("src/slots.ts", "options")).has("src/callerA.ts")).toBe(false);
  });

  test("an OPAQUE default slot is reported as a blindspot, not as zero and not asserted on a symbol", async () => {
    if (!available()) return;
    const set = await consumersOf("src/opaque.ts", "helper");
    expect(resolvedFiles(set).size).toBe(0);                        // never asserted against `helper`
    expect(set.unresolved.map((u) => u.mechanism)).toContain("opaque-default-export");
    const b = set.unresolved.find((u) => u.mechanism === "opaque-default-export")!;
    expect(b.candidates).toContain("src/callerOpaque.ts");          // the real importer is NAMED, not hidden
    expect(set.reason).toBe("opaque");                              // not the confident "none"
  });
});
