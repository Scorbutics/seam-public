// CLI arg parsing — the `--format llm-context` default that skips the LLM seam-intent (ranking) pass, and
// its opt-outs. An LLM consumer ranks/interprets the structure itself, so Seam's own LLM ranking pass is
// redundant latency/cost there; for human/JSON formats it stays on.
import { describe, expect, test } from "bun:test";
import { parseArgs, parseCenters } from "../../src/cli/args.js";

describe("parseArgs — llm-context defaults the LLM seam-ranking pass OFF (skeleton)", () => {
  test("--format llm-context ⇒ skeleton on (skip the seam-intent/refine LLM passes)", () => {
    expect(parseArgs(["--format", "llm-context"]).skeleton).toBe(true);
  });
  test("--rank / --no-skeleton override it back ON even under llm-context", () => {
    expect(parseArgs(["--format", "llm-context", "--rank"]).skeleton).toBe(false);
    expect(parseArgs(["--format", "llm-context", "--no-skeleton"]).skeleton).toBe(false);
  });
  test("an explicit --skeleton under llm-context stays on (idempotent)", () => {
    expect(parseArgs(["--format", "llm-context", "--skeleton"]).skeleton).toBe(true);
  });
  test("non-llm-context formats are UNCHANGED — the ranking pass stays available (skeleton unset)", () => {
    expect(parseArgs(["--format", "ascii"]).skeleton).toBeUndefined();
    expect(parseArgs(["--format", "llm"]).skeleton).toBeUndefined();
    expect(parseArgs([]).skeleton).toBeUndefined();
  });
  test("--skeleton on its own (no format) still works (the original behaviour)", () => {
    expect(parseArgs(["--skeleton"]).skeleton).toBe(true);
  });
  test("the WAVE / SCENARIO views also default skeleton ON (they read the det structure, not the LLM tiers)", () => {
    // …and --rank / --no-skeleton force the LLM pass back on there too
  });
});

describe("--center — the universal node address (supersedes --anchor-file/--symbol)", () => {
  test("file#symbol expands to the internal anchor (so every mode — footprint/shapes/grow — accepts it)", () => {
    const a = parseArgs(["--center", "svc/foo.ts#createFoo"]);
    expect(a.anchorFile).toBe("svc/foo.ts");
    expect(a.symbol).toBe("createFoo");
  });
  test("bare file = a MODULE anchor (no symbol)", () => {
    const a = parseArgs(["--center", "svc/foo.ts"]);
    expect(a.anchorFile).toBe("svc/foo.ts");
    expect(a.symbol).toBeUndefined();
  });
  test("a symbol may itself be qualified — split is on the FIRST '#' only", () => {
    const a = parseArgs(["--center", "svc/foo.ts#Ns#deep"]);
    expect(a.anchorFile).toBe("svc/foo.ts");
    expect(a.symbol).toBe("Ns#deep");
  });
  test("an explicit --anchor-file/--symbol still WINS (back-compat)", () => {
    const a = parseArgs(["--center", "svc/foo.ts#createFoo", "--anchor-file", "svc/bar.ts", "--symbol", "other"]);
    expect(a.anchorFile).toBe("svc/bar.ts");
    expect(a.symbol).toBe("other");
  });
  test("parseCenters — a comma-separated multi-center list (concern star)", () => {
    expect(parseCenters("a.ts#x, b.ts#y ,c.ts")).toEqual([
      { file: "a.ts", symbol: "x" }, { file: "b.ts", symbol: "y" }, { file: "c.ts" },
    ]);
    // the FIRST center is what the arg expansion addresses
    expect(parseArgs(["--center", "a.ts#x,b.ts#y"]).symbol).toBe("x");
  });
  test("no --center leaves the anchor untouched", () => {
    const a = parseArgs(["--anchor-file", "svc/foo.ts", "--symbol", "createFoo"]);
    expect(a.center).toBeUndefined();
    expect(a.anchorFile).toBe("svc/foo.ts");
  });
});

describe("parseArgs — data-coupling mode (auto is the default)", () => {
  test("no flag → auto (cross-stack on when a backend resolves, floor otherwise)", () => {
    const a = parseArgs([]);
    expect(a.dataCoupling).toBe(true);
    expect(a.dataCouplingAuto).toBe(true);
    expect(a.dataCouplingLlm).toBe(false);   // resolved at runtime by backend availability, not here
  });
  test("--data-coupling floor → deterministic, auto OFF", () => {
    const a = parseArgs(["--data-coupling", "floor"]);
    expect(a.dataCouplingAuto).toBe(false);
    expect(a.dataCouplingLlm).toBe(false);
  });
  test("--data-coupling llm → always-on LLM, auto OFF", () => {
    const a = parseArgs(["--data-coupling", "llm"]);
    expect(a.dataCouplingAuto).toBe(false);
    expect(a.dataCouplingLlm).toBe(true);
  });
  test("--data-coupling auto → explicit auto", () => {
    expect(parseArgs(["--data-coupling", "auto"]).dataCouplingAuto).toBe(true);
  });
  test("--data-coupling off / --no-data-coupling → disabled, auto OFF", () => {
    expect(parseArgs(["--data-coupling", "off"]).dataCoupling).toBe(false);
    const n = parseArgs(["--no-data-coupling"]);
    expect(n.dataCoupling).toBe(false);
    expect(n.dataCouplingAuto).toBe(false);
  });
});
