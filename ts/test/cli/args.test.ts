// CLI arg parsing — the `--format llm-context` default that skips the LLM seam-intent (ranking) pass, and
// its opt-outs. An LLM consumer ranks/interprets the structure itself, so Seam's own LLM ranking pass is
// redundant latency/cost there; for human/JSON formats it stays on.
import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/args.js";

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
