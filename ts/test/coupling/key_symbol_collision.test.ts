// REPRODUCTION of the proprietary-repo failure (a Java/EJB monorepo): the per-file LLM key synthesis
// ECHOED code symbols it saw — a class `MessageBean`, a method `validateDocumentCount` — and the word
// `"the"`, proposing them as `db-table` keys. They then grounded by coincidence and fanned out to
// unrelated files. This locks the two guards that kill that class of noise, WITHOUT needing the closed
// source: a stubbed HostBus plays the hallucinating model over a tiny Java fixture.
//   • plausibility guard   → drops generic/prose values ("the")
//   • symbol-collision     → drops values that are class/method names DEFINED in the synthesized file
// A real table name (`member_payments`, a string literal, not a code symbol) must SURVIVE.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { llmKeyIndex } from "../../src/codebase/coupling/llm_key_index.js";
import { _resetKeyCacheMem } from "../../src/codebase/coupling/key_store.js";
import { _resetMatcherCacheMem } from "../../src/codebase/coupling/key_store.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

// A Java bean defining a class + method (the symbols the model will echo) and touching a real table literal.
const JAVA =
  "package com.acme.core;\n" +
  "public class MessageBean {\n" +
  "  public void validateDocumentCount() {\n" +
  '    persist("member_payments");\n' +
  "  }\n" +
  "}\n";

// The hallucinating model: proposes the class name, the method name, and "the" as db-table keys, plus the
// one REAL table. Keyed by the discover-keys-batch tag (other passes — matchers, carrier — get "[]").
class HallucinatingBus extends HostBus {
  serve(tag: string): string {
    if (tag !== "discover-keys-batch") return "[]";
    return JSON.stringify([
      { id: "k1", file: "MessageBean.java", kind: "db-table", value: "MessageBean", role: "produces" },
      { id: "k2", file: "MessageBean.java", kind: "db-table", value: "validateDocumentCount", role: "produces" },
      { id: "k3", file: "MessageBean.java", kind: "db-table", value: "the", role: "produces" },
      { id: "k4", file: "MessageBean.java", kind: "db-table", value: "member_payments", role: "produces" },
    ]);
  }
}

let REPO: string, SHARED: string;
beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "sc-repo-")); SHARED = mkdtempSync(join(tmpdir(), "sc-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED;
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, "MessageBean.java"), JAVA);
  _resetKeyCacheMem(); _resetMatcherCacheMem(); set_host_bus(null);
});
afterEach(() => {
  rmSync(REPO, { recursive: true, force: true }); rmSync(SHARED, { recursive: true, force: true });
  delete process.env.SEAM_ADAPTERS_DIR; set_host_bus(null); _resetKeyCacheMem(); _resetMatcherCacheMem();
});

describe("per-file LLM key synthesis — code-symbol & generic-word guards", () => {
  test("class-name, method-name, and 'the' keys are dropped; the real table survives", async () => {
    if (!available()) return;   // symbol-collision needs tree-sitter to read the Java defs
    set_host_bus(new HallucinatingBus());
    const idx = await llmKeyIndex(REPO, { llm: true }, new EngineCtx());

    expect(idx.has("db-table member_payments")).toBe(true);          // real table literal → kept
    expect(idx.has("db-table MessageBean")).toBe(false);            // class name → symbol-collision drop
    expect(idx.has("db-table validateDocumentCount")).toBe(false);  // method name → symbol-collision drop
    expect(idx.has("db-table the")).toBe(false);                    // generic word → plausibility drop
  });
});
