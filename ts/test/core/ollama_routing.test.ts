// The cheap-tier → Ollama route is OPT-IN and DEGRADING: a local fast SLM serves cheap classification passes
// (the grow-border judge) only when SEAM_OLLAMA_MODEL is set AND the server is reachable AND the pass is
// `cheap` tier; otherwise the pass falls back to claude. This pins those gates — the safety contract that
// makes the feature land with ZERO default behaviour change:
//   1. unset SEAM_OLLAMA_MODEL → never routed (the default — so existing behaviour is untouched);
//   2. a STRONG-tier pass is never routed to Ollama even when configured (it needs the capable model);
//   3. configured-but-unreachable degrades to false (no Ollama server on the test host → claude).
// Pure routing decision (no real HTTP / no model needed) → green offline / in CI.
import { describe, expect, test, afterEach } from "bun:test";
import { registerPass, _cheapViaOllama, _resetOllamaProbe } from "../../src/core/llm.js";

registerPass({ tag: "test-ollama-cheap", tier: "cheap" });
registerPass({ tag: "test-ollama-strong", tier: "strong" });

afterEach(() => { delete process.env.SEAM_OLLAMA_MODEL; _resetOllamaProbe(); });

describe("cheap-tier Ollama routing — opt-in + degrading", () => {
  test("unset SEAM_OLLAMA_MODEL → cheap pass is NOT routed to Ollama (default, no behaviour change)", () => {
    _resetOllamaProbe();
    expect(_cheapViaOllama("test-ollama-cheap")).toBe(false);
  });

  test("a strong-tier pass is never routed to Ollama, even when configured", () => {
    process.env.SEAM_OLLAMA_MODEL = "qwen2.5:3b";
    process.env.SEAM_OLLAMA_URL = "http://127.0.0.1:6"; // unreachable, but the tier gate short-circuits first
    _resetOllamaProbe();
    expect(_cheapViaOllama("test-ollama-strong")).toBe(false);
    delete process.env.SEAM_OLLAMA_URL;
  });

  test("configured but server unreachable → degrades to false (falls back to claude)", () => {
    process.env.SEAM_OLLAMA_MODEL = "qwen2.5:3b";
    process.env.SEAM_OLLAMA_URL = "http://127.0.0.1:6"; // nothing listens here
    _resetOllamaProbe();
    expect(_cheapViaOllama("test-ollama-cheap")).toBe(false);
    delete process.env.SEAM_OLLAMA_URL;
  });

  test("an unregistered tag is never routed (only declared cheap passes are)", () => {
    process.env.SEAM_OLLAMA_MODEL = "qwen2.5:3b";
    _resetOllamaProbe();
    expect(_cheapViaOllama("no-such-pass")).toBe(false);
  });
});
