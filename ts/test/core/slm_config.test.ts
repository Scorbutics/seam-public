// The provisioned local-SLM config (~/.seam/slm.json, written by `seam slm install`) is read by the engine so
// a fast local model serves the cheap tier with no env vars. This pins the config layer (the provisioner's
// HTTP/spawn parts are validated manually): write→read roundtrip, and applySlmConfigToEnv() applies it to the
// env the engine reads while NEVER overriding an explicit SEAM_OLLAMA_* (env wins — the file is a default).
// SEAM_SLM_CONFIG points the path at a tmp file, so the test is hermetic regardless of a host's real config.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { ollamaBin } from "../../src/core/llm.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSlmConfig, writeSlmConfig, applySlmConfigToEnv, resetSlmConfig } from "../../src/core/slm_config.js";

let DIR: string;
const OLLAMA_ENV = ["SEAM_OLLAMA_MODEL", "SEAM_OLLAMA_URL"] as const;
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "slm-cfg-"));
  process.env.SEAM_SLM_CONFIG = join(DIR, "slm.json");
  for (const k of OLLAMA_ENV) delete process.env[k];
  resetSlmConfig();
});
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  delete process.env.SEAM_SLM_CONFIG;
  for (const k of OLLAMA_ENV) delete process.env[k];
  resetSlmConfig();
});

describe("slm config — provisioned local-SLM defaults", () => {
  test("no file → readSlmConfig null and applySlmConfigToEnv is a no-op", () => {
    expect(readSlmConfig()).toBeNull();
    applySlmConfigToEnv();
    expect(process.env.SEAM_OLLAMA_MODEL).toBeUndefined();
  });

  test("write→read roundtrip", () => {
    writeSlmConfig({ model: "qwen2.5:3b", url: "http://127.0.0.1:11434", bin: "/x/ollama" });
    resetSlmConfig();
    expect(readSlmConfig()).toEqual({ model: "qwen2.5:3b", url: "http://127.0.0.1:11434", bin: "/x/ollama" });
  });

  test("applySlmConfigToEnv applies model/url/bin when env is unset", () => {
    writeSlmConfig({ model: "qwen2.5:1.5b", url: "http://127.0.0.1:11434", bin: "/x/ollama" });
    resetSlmConfig();
    applySlmConfigToEnv();
    expect(process.env.SEAM_OLLAMA_MODEL).toBe("qwen2.5:1.5b");
    expect(process.env.SEAM_OLLAMA_URL).toBe("http://127.0.0.1:11434");
    expect(ollamaBin()).toBe("/x/ollama");   // handed over in-process, not via SEAM_OLLAMA_BIN
  });

  test("an explicit env var WINS over the file (the file is only a default)", () => {
    process.env.SEAM_OLLAMA_MODEL = "llama3.2:3b";
    writeSlmConfig({ model: "qwen2.5:3b", url: "http://127.0.0.1:11434", bin: "/x/ollama" });
    resetSlmConfig();
    applySlmConfigToEnv();
    expect(process.env.SEAM_OLLAMA_MODEL).toBe("llama3.2:3b");   // not overridden
    expect(process.env.SEAM_OLLAMA_URL).toBe("http://127.0.0.1:11434");   // unset → applied
  });

  test("a malformed file is ignored (null, not a throw)", () => {
    writeSlmConfig({ model: "", url: "", bin: null });   // missing model/url ⇒ invalid
    resetSlmConfig();
    expect(readSlmConfig()).toBeNull();
  });
});
