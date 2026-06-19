// Phase 1 gate: the deterministic LLM plumbing. extractJsonArray must match Python's
// _extract_json_array on the tricky cases (fences, leading [], prose, longest-array fallback);
// the HostBus must record (tag, prompt, thinking) and return the canned/empty reply like Python.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractJsonArray, HostBus, set_host_bus, get_host_bus } from "../../src/core/llm.js";

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
