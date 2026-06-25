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
