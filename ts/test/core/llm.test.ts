// Phase 1 gate: the deterministic LLM plumbing. extractJsonArray must match Python's
// _extract_json_array on the tricky cases (fences, leading [], prose, longest-array fallback);
// the HostBus must record (tag, prompt, thinking) and return the canned/empty reply like Python.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractJsonArray, HostBus, set_host_bus, get_host_bus,
  registerPass, getPass, allPasses, runPassRaw } from "../../src/core/llm.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(__dir, "..", "oracle", "extract_json.json"), "utf-8"));

describe("extractJsonArray vs Python oracle", () => {
  cases.forEach((c: any, i: number) => {
    test(`case ${i}`, () => {
      if (c.ok) expect(extractJsonArray(c.in)).toEqual(c.parsed);
      else expect(() => extractJsonArray(c.in)).toThrow();
    });
  });
});

describe("HostBus (emit / inject contract)", () => {
  test("emit phase records prompt and returns []", () => {
    const bus = new HostBus();
    set_host_bus(bus);
    expect(get_host_bus()).toBe(bus);
    const reply = bus.serve("cluster", "PROMPT-TEXT", "claude-haiku-4-5", 2048);
    expect(reply).toBe("[]");
    expect(bus.recorded.get("cluster")).toEqual({ prompt: "PROMPT-TEXT", model: "claude-haiku-4-5", thinking: 2048 });
    set_host_bus(null);
  });
  test("inject phase returns the seeded reply", () => {
    const bus = new HostBus({ cluster: '[{"id":"h1"}]' });
    expect(bus.serve("cluster", "P", "m", null)).toBe('[{"id":"h1"}]');
    expect(bus.serve("reconcile", "P2", "m", 0)).toBe("[]"); // unseeded → []
  });
});

describe("pass registry (tier routing + enumeration)", () => {
  test("registerPass returns the spec and getPass retrieves it", () => {
    const spec = registerPass({ tag: "test-cheap", tier: "cheap" });
    expect(spec.tag).toBe("test-cheap");
    expect(getPass("test-cheap")).toEqual(spec);
    expect(getPass("never-registered")).toBeUndefined();
  });

  test("re-registering the same tier is idempotent; a conflicting tier throws", () => {
    registerPass({ tag: "test-dup", tier: "cheap" });
    expect(() => registerPass({ tag: "test-dup", tier: "cheap" })).not.toThrow();
    expect(() => registerPass({ tag: "test-dup", tier: "strong" })).toThrow();
  });

  test("allPasses enumerates registered passes, tag-sorted", () => {
    registerPass({ tag: "zzz-pass", tier: "cheap" });
    registerPass({ tag: "aaa-pass", tier: "strong" });
    const tags = allPasses().map((p) => p.tag);
    expect(tags).toContain("zzz-pass");
    expect(tags).toContain("aaa-pass");
    expect(tags.indexOf("aaa-pass")).toBeLessThan(tags.indexOf("zzz-pass"));
  });

  // The routing fires at the runPassRaw choke point; the host bus records the model it was served with,
  // so we can assert the upgrade without a live backend. STRONG_MODEL defaults to claude-sonnet-4-6.
  test("a strong pass upgrades a haiku base; a cheap pass and a stronger base are untouched", () => {
    registerPass({ tag: "test-strong-haiku", tier: "strong" });
    registerPass({ tag: "test-strong-opus", tier: "strong" });
    registerPass({ tag: "test-stays-cheap", tier: "cheap" });
    const bus = new HostBus();
    set_host_bus(bus);
    runPassRaw("host", "", "P", "claude-haiku-4-5", 0, "test-strong-haiku"); // weak base → upgrade
    runPassRaw("host", "", "P", "claude-haiku-4-5", 0, "test-stays-cheap");  // cheap → untouched
    runPassRaw("host", "", "P", "claude-opus-4-8", 0, "test-strong-opus");   // never downgrade a strong base
    set_host_bus(null);
    expect(bus.recorded.get("test-strong-haiku")?.model).toBe("claude-sonnet-4-6");
    expect(bus.recorded.get("test-stays-cheap")?.model).toBe("claude-haiku-4-5");
    expect(bus.recorded.get("test-strong-opus")?.model).toBe("claude-opus-4-8");
  });
});

import { writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("LLM subprocess hang guard (timeout)", () => {
  test("a stalled backend is killed and the pass THROWS — it does not block forever", () => {
    // a fake `claude` that ignores its args and hangs; the wall-clock ceiling must kill it and surface a failure
    // (which the callers catch → degrade to their deterministic floor) instead of freezing the whole pipeline.
    const dir = mkdtempSync(join(tmpdir(), "seam-llm-hang-"));
    const bin = join(dir, "hang.sh");
    writeFileSync(bin, "#!/bin/sh\nsleep 60\n"); chmodSync(bin, 0o755);
    const prev = process.env.SEAM_LLM_TIMEOUT_MS; process.env.SEAM_LLM_TIMEOUT_MS = "200";
    try {
      const t0 = performance.now();
      expect(() => runPassRaw("claude", bin, "hi", "claude-haiku-4-5", 0, "seam-intent")).toThrow(/timed out/);
      expect(performance.now() - t0).toBeLessThan(5000);   // killed promptly (2 retries x 200ms), not a 60s hang
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.SEAM_LLM_TIMEOUT_MS; else process.env.SEAM_LLM_TIMEOUT_MS = prev;
    }
  });
});
